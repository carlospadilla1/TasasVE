/* ============================================================
 * Tasas Venezuela · Servidor local (sin dependencias)
 * ------------------------------------------------------------
 * Node >= 18. Uso:
 *     node server.js            → http://localhost:3000
 *     PORT=8080 node server.js  → puerto personalizado
 *
 * Qué hace:
 *   1. Sirve los archivos estáticos de la PWA (index.html, sw.js…).
 *   2. Proxy /api/rates:
 *      a) Con COTIZAVE_API_KEY: consulta la API de Cotizave
 *         (payload completo) y añade la key en el servidor.
 *      b) Sin key (o si la API falla): SCRAPING PÚBLICO server-side
 *         · bcv.org.ve   → USD y EUR oficiales (caché 30 min)
 *         · cotizave.com → Binance P2P          (caché 5 min)
 *         El navegador NUNCA scraping: sin CORS, sin puentes de
 *         terceros (r.jina.ai queda como último recurso cliente).
 *
 * Configuración de la key (en orden de prioridad):
 *   - Variable de entorno COTIZAVE_API_KEY (opcional)
 * ============================================================ */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.COTIZAVE_API_KEY;

const UPSTREAM = 'https://api.cotizave.com/v1/fx/rates';
const CURRENCIES_UPSTREAM = 'https://api.cotizave.com/v1/fx/bcv/currencies';
const BCV_HOME = 'https://www.bcv.org.ve/';
const COTIZAVE_HOME = 'https://cotizave.com';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ── Caché de scraping (por fuente, TTL distinto) ──────────────
 * El BCV actualiza 1 vez al día → 30 min es holgado.
 * Cotizave refresca P2P cada ~5 min. */
const SCRAPE_TTL_MS = { bcv: 30 * 60 * 1000, cotizave: 5 * 60 * 1000 };
const scrapeCache = { bcv: { at: 0, rates: null }, cotizave: { at: 0, rates: null } };

const parseNumero = (v) => parseFloat(String(v).replace(/\./g, '').replace(',', '.'));

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

/* Scrapea la portada del BCV: USD y EUR oficiales + Fecha Valor.
 * Estructura estable: <span> EUR </span> … <strong class="strong-tb"> 974,09309112</strong>
 * Fecha Valor: <span content="2026-09-21T00:00:00-04:00">…</span> */
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

  // Fecha valor oficial del BCV → el frontend la muestra como "Vigente desde el…"
  const fv = html.match(/Fecha Valor:[\s\S]{0,300}?content="([^"]+)"/);
  if (fv) {
    const d = new Date(fv[1]);
    if (!Number.isNaN(d.getTime())) for (const r of rates) r.updated_at = d.toISOString();
  }

  scrapeCache.bcv = { at: Date.now(), rates };
  console.log(`  ▸ [bcv] scrapeado: ${rates.map((r) => `${r.market}=${r.mid}`).join('  ')}`);
  return rates;
}

/* Scrapea cotizave.com: Binance P2P (+ BCV como respaldo).
 * Líneas estables: "BN Binance P2P 21 sep · 07:19 Bs.947,04" y
 * "BCV BCV oficial Vigente desde el … Bs.849,56". */
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
      meta_text: meta ? meta[1] : null,
      updated_at: new Date().toISOString(), source: 'cotizave.com',
    });
  }
  const bcv = texto.match(/BCV\s+BCV oficial[^\n]*?Bs\.\s*([\d.,]+)/);
  if (bcv && Number.isFinite(parseNumero(bcv[1]))) {
    const since = texto.match(/Vigente desde el ([a-záéíóúñ]+ \d{1,2} de [a-záéíóúñ]+)/i);
    rates.push({
      market: 'bcv', type: 'reference', base: 'USD', mid: parseNumero(bcv[1]),
      since_text: since ? since[1] : null,
      updated_at: new Date().toISOString(), source: 'cotizave.com',
    });
  }
  if (!rates.length) throw new Error('cotizave.com: no se pudieron extraer tasas (formato cambiado)');

  scrapeCache.cotizave = { at: Date.now(), rates };
  console.log(`  ▸ [cotizave] scrapeado: ${rates.map((r) => `${r.market}=${r.mid}`).join('  ')}`);
  return rates;
}

/* Payload público sin API key: BCV oficial + Binance P2P en paralelo.
 * Si el scrape del BCV falla, el BCV de cotizave actúa de respaldo. */
async function buildPublicRates() {
  const [bcv, cot] = await Promise.allSettled([scrapeBcvOficial(), scrapeCotizave()]);
  if (bcv.status === 'rejected') console.error('  ▸ [rates-proxy] scrape BCV falló:', String(bcv.reason && bcv.reason.message || bcv.reason));
  if (cot.status === 'rejected') console.error('  ▸ [rates-proxy] scrape cotizave falló:', String(cot.reason && cot.reason.message || cot.reason));

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

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

async function proxyRates(req, res) {
  const json = (status, body) => {
    res.writeHead(status, JSON_HEADERS);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // 1) Con API key: payload completo de la API de Cotizave
  if (API_KEY) {
    try {
      const upstream = await fetch(UPSTREAM, {
        headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
      });
      const body = await upstream.text();
      if (!upstream.ok) {
        console.error('  ▸ [rates-proxy] upstream rechazó la petición:', {
          status: upstream.status, body: body.slice(0, 200), apiKeyPresent: true,
        });
      } else {
        let payload = null;
        try { payload = JSON.parse(body); } catch (_) {}
        if (payload) {
          // Inyecta el Euro desde /fx/bcv/currencies si el payload no lo trajo
          try {
            const currencies = await fetch(CURRENCIES_UPSTREAM, {
              headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
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
    } catch (err) {
      console.error('  ▸ [rates-proxy] upstream inaccesible:', String(err));
    }
  }

  // 2) Sin key o API caída: scraping público server-side (con caché)
  const pub = await buildPublicRates();
  if (pub) return json(200, pub);

  // 3) Nada disponible: error explícito y diagnosticable
  if (!API_KEY) return json(500, { code: 'missing_api_key', hint: 'Sin COTIZAVE_API_KEY y el scraping público también falló' });
  return json(502, { code: 'proxy_upstream_error', hint: 'La API falló y el scraping público también falló' });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: cualquier ruta desconocida sirve el shell
      if (!path.extname(urlPath)) {
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // El SW debe servirse con scope raíz
    if (urlPath === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (req.url.startsWith('/api/rates')) return void proxyRates(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Tasas Venezuela · servidor local');
  console.log(`  ▸ App:       http://localhost:${PORT}`);
  console.log(`  ▸ API proxy: http://localhost:${PORT}/api/rates`);
  console.log(`  ▸ Key:       ${API_KEY ? API_KEY.slice(0, 12) + '••••' : '(sin key → scraping público)'}`);
  console.log('');
});
