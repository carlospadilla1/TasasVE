'use strict';

const UPSTREAM = 'https://api.cotizave.com/v1/fx/rates';

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

    return {
      statusCode: upstream.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body,
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
