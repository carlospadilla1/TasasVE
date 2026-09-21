'use strict';

/* ============================================================
 * Proxy serverless de tasas (Netlify Function)
 * ------------------------------------------------------------
 * 1) Con COTIZAVE_API_KEY: payload completo de la API de Cotizave
 *    (inyecta el Euro desde /fx/bcv/currencies si falta).
 * 2) Sin key (o API caída): scraping público server-side con caché
 *    · bcv.org.ve   → USD y EUR oficiales (caché 30 min)
 *    · cotizave.com → Binance P2P          (caché 5 min)
 *    El navegador NUNCA scraping: sin CORS ni puentes de terceros.
 * ============================================================ */

const https = require('https');

const UPSTREAM = 'https://api.cotizave.com/v1/fx/rates';
const CURRENCIES_UPSTREAM = 'https://api.cotizave.com/v1/fx/bcv/currencies';
const BCV_HOME = 'https://www.bcv.org.ve/';
const COTIZAVE_HOME = 'https://cotizave.com';

/* bcv.org.ve sirve una cadena TLS incompleta que Node rechaza (los
 * navegadores la toleran). Agente relajado SOLO para esta fuente
 * pública: dato de referencia sin secretos en juego. */
const AGENTE_BCV = new https.Agent({ rejectUnauthorized: false });

function httpsGet(url, { agent, ms = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent,
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: ms,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(new URL(res.headers.location, url).href, { agent, ms }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} → HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${ms} ms en ${url}`)));
    req.on('error', reject);
  });
}

const SCRAPE_TTL_MS = { bcv: 30 * 60 * 1000, cotizave: 5 * 60 * 1000 };
/* En serverless el módulo sobrevive entre invocaciones "warm";
 * en frío simplemente se scrapea de nuevo. */
const scrapeCache = { bcv: { at: 0, rates: null }, cotizave: { at: 0, rates: null } };

const parseNumero = (v) => parseFloat(String(v).replace(/\./g, '').replace(',', '.'));

async function scrapeBcvOficial() {
  const c = scrapeCache.bcv;
  if (c.rates && Date.now() - c.at < SCRAPE_TTL_MS.bcv) return c.rates;

  const html = await httpsGet(BCV_HOME, { agent: AGENTE_BCV });

  const rates = [];
  for (const { market, code } of [
    { market: 'eur_reference', code: 'EUR' },
    { market: 'reference', code: 'USD' },
  ]) {
    const m = html.match(
      new RegExp(`${code}\\s*</span>[\\s\\S]{0,200}?<strong[^>]*>\\s*([\\d.,]+)\\s*</strong>`, 'i')
    );
    const mid = m ? parseNumero(m[1]) : NaN;
    if (Number.isFinite(mid)) {
      rates.push({ market, type: 'reference', base: code, mid, updated_at: new Date().toISOString(), source: 'bcv.org.ve' });
    }
  }
  if (!rates.length) throw new Error('bcv.org.ve: no se pudieron extraer USD/EUR (formato cambiado)');

  // Fecha valor oficial → updated_at real de la publicación del BCV
  const fv = html.match(/Fecha Valor:[\s\S]{0,300}?content="([^"]+)"/);
  if (fv) {
    const d = new Date(fv[1]);
    if (!Number.isNaN(d.getTime())) for (const r of rates) r.updated_at = d.toISOString();
  }

  scrapeCache.bcv = { at: Date.now(), rates };
  console.log('[rates-proxy] bcv.org.ve scrapeado:', rates.map((r) => `${r.market}=${r.mid}`).join('  '));
  return rates;
}

async function scrapeCotizave() {
  const c = scrapeCache.cotizave;
  if (c.rates && Date.now() - c.at < SCRAPE_TTL_MS.cotizave) return c.rates;

  const res = await fetch(COTIZAVE_HOME, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${COTIZAVE_HOME} → HTTP ${res.status}`);
  const html = await res.text();
  // Se aplana el HTML a texto (mismos regex que el parser del cliente)
  const texto = html.replace(/<[^>]+>/g, ' ');

  const rates = [];
  const bin = texto.match(/BN\s+Binance P2P[^\n]*?Bs\.\s*([\d.,]+)/);
  if (bin && Number.isFinite(parseNumero(bin[1]))) {
    const meta = texto.match(/BN\s+Binance P2P\s+(\d{1,2} \w{3} · \d{2}:\d{2})/);
    rates.push({
      market: 'binance_p2p', type: 'p2p', base: 'USD', mid: parseNumero(bin[1]),
      meta_text: meta ? meta[1].replace(/\s+/g, ' ') : null,
      updated_at: new Date().toISOString(), source: 'cotizave.com',
    });
  }
  const bcv = texto.match(/BCV\s+BCV oficial[^\n]*?Bs\.\s*([\d.,]+)/);
  if (bcv && Number.isFinite(parseNumero(bcv[1]))) {
    const since = html.match(/Vigente desde el ([a-záéíóúñ]+ \d{1,2} de [a-záéíóúñ]+)/i);
    rates.push({
      market: 'bcv', type: 'reference', base: 'USD', mid: parseNumero(bcv[1]),
      since_text: since ? since[1] : null,
      updated_at: new Date().toISOString(), source: 'cotizave.com',
    });
  }
  if (!rates.length) throw new Error('cotizave.com: no se pudieron extraer tasas (formato cambiado)');

  scrapeCache.cotizave = { at: Date.now(), rates };
  console.log('[rates-proxy] cotizave.com scrapeado:', rates.map((r) => `${r.market}=${r.mid}`).join('  '));
  return rates;
}

async function buildPublicRates() {
  const [bcv, cot] = await Promise.allSettled([scrapeBcvOficial(), scrapeCotizave()]);
  if (bcv.status === 'rejected') console.error('[rates-proxy] scrape BCV falló:', String((bcv.reason && bcv.reason.message) || bcv.reason));
  if (cot.status === 'rejected') console.error('[rates-proxy] scrape cotizave falló:', String((cot.reason && cot.reason.message) || cot.reason));

  const rates = [];
  if (bcv.status === 'fulfilled') rates.push(...bcv.value);
  if (cot.status === 'fulfilled') {
    for (const r of cot.value) {
      if (r.market === 'binance_p2p' || (r.market === 'bcv' && !rates.some((x) => x.market === 'reference'))) {
        rates.push(r);
      }
    }
  }
  return rates.length
    ? { country: 'VE', currency: 'VES', base: 'USD', rates, fetched_at: new Date().toISOString(), source: 'scrape-publico' }
    : null;
}

const baseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
};

const json = (statusCode, body) => ({ statusCode, headers: baseHeaders, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { code: 'method_not_allowed' });
  }

  const apiKey = process.env.COTIZAVE_API_KEY;

  // 1) Con API key: payload completo de la API de Cotizave
  if (apiKey) {
    try {
      const upstream = await fetch(UPSTREAM, {
        headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      });
      const body = await upstream.text();

      if (!upstream.ok) {
        console.error('[rates-proxy] upstream rechazó la petición:', {
          status: upstream.status,
          body: body.slice(0, 200),
          apiKeyPresent: true,
        });
      } else {
        let payload = null;
        try { payload = JSON.parse(body); } catch (_) {}
        if (payload) {
          // Inyecta el Euro desde /fx/bcv/currencies si el payload no lo trajo
          try {
            const currencies = await fetch(CURRENCIES_UPSTREAM, {
              headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
            });
            if (currencies.ok) {
              const currencyPayload = await currencies.json();
              const euro = Number(currencyPayload?.rates?.EUR);
              const rates = Array.isArray(payload.rates) ? payload.rates : [];
              if (Number.isFinite(euro) && !rates.some((rate) => rate.market === 'eur_reference')) {
                rates.push({
                  market: 'eur_reference', type: 'reference', mid: euro,
                  updated_at: currencyPayload.captured_at,
                  effective_date: currencyPayload.reference_value_date,
                });
                payload.rates = rates;
              }
            }
          } catch (_) {}
          return json(200, payload);
        }
      }
    } catch (error) {
      console.error('[rates-proxy] upstream inaccesible:', String(error));
    }
  }

  // 2) Sin key o API caída: scraping público server-side (con caché)
  const pub = await buildPublicRates();
  if (pub) return json(200, pub);

  // 3) Nada disponible: error explícito y diagnosticable
  if (!apiKey) {
    return json(500, { code: 'missing_api_key', hint: 'Sin COTIZAVE_API_KEY y el scraping público también falló' });
  }
  return json(502, { code: 'proxy_upstream_error', hint: 'La API falló y el scraping público también falló' });
};
