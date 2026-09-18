'use strict';

const UPSTREAM = 'https://api.cotizave.com/v1/fx/rates';
const CURRENCIES_UPSTREAM = 'https://api.cotizave.com/v1/fx/bcv/currencies';

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
    return {
      statusCode: 405,
      headers: { Allow: 'GET, OPTIONS' },
      body: JSON.stringify({ code: 'method_not_allowed' }),
    };
  }

  const apiKey = process.env.COTIZAVE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'missing_api_key' }),
    };
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    });
    const body = await upstream.text();
    let responseBody = body;

    if (upstream.ok) {
      try {
        const payload = JSON.parse(body);
        const currencies = await fetch(CURRENCIES_UPSTREAM, {
          headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
        });
        if (currencies.ok) {
          const currencyPayload = await currencies.json();
          const euro = Number(currencyPayload?.rates?.EUR);
          const rates = Array.isArray(payload.rates) ? payload.rates : [];
          if (Number.isFinite(euro) && !rates.some((rate) => rate.market === 'eur_reference')) {
            rates.push({
              market: 'eur_reference',
              type: 'reference',
              mid: euro,
              updated_at: currencyPayload.captured_at,
              effective_date: currencyPayload.reference_value_date,
            });
            payload.rates = rates;
            responseBody = JSON.stringify(payload);
          }
        }
      } catch (_) {}
    }

    return {
      statusCode: upstream.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: responseBody,
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ code: 'proxy_upstream_error', message: String(error) }),
    };
  }
};
