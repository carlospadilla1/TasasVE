/* ============================================================
 * Tasas Venezuela · Servidor local (sin dependencias)
 * ------------------------------------------------------------
 * Node >= 18. Uso:
 *     node server.js            → http://localhost:3000
 *     PORT=8080 node server.js  → puerto personalizado
 *
 * Qué hace:
 *   1. Sirve los archivos estáticos de la PWA (index.html, sw.js…).
 *   2. Proxy /api/rates → https://api.cotizave.com/v1/fx/rates
 *      añadiendo el header X-API-Key en el servidor, de modo que
 *      la API key NUNCA llega al navegador y se evita el bloqueo
 *      CORS del endpoint directo.
 *
 * Configuración de la key (en orden de prioridad):
 *   - Variable de entorno COTIZAVE_API_KEY
 *   - Si no existe, las consultas fallan de forma explícita
 * ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.COTIZAVE_API_KEY;

const UPSTREAM = 'https://api.cotizave.com/v1/fx/rates';
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

async function proxyRates(req, res) {
  if (!API_KEY) {
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ code: 'missing_api_key' }));
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ code: 'proxy_upstream_error', message: String(err) }));
  }
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
  console.log(`  ▸ App:      http://localhost:${PORT}`);
  console.log(`  ▸ API proxy: http://localhost:${PORT}/api/rates`);
  console.log(`  ▸ Key:      ${API_KEY ? API_KEY.slice(0, 12) + '••••' : '(no configurada)'}`);
  console.log('');
});
