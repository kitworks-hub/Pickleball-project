/* Local test server: serves index.html and runs the /api functions with the same handlers Vercel uses.
   With no Supabase variables set it keeps data in memory (lost when it stops).
   Usage: node scripts/dev-server.js [port] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 3000;
const api = { '/api/auth': require('../api/auth'), '/api/data': require('../api/data'), '/api/pay': require('../api/pay') };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = api[url.pathname];
  if (!fn) {
    const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/icon.jpg': ['icon.jpg', 'image/jpeg'], '/icon-32.png': ['icon-32.png', 'image/png'], '/icon-48.png': ['icon-48.png', 'image/png'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/firebase-messaging-sw.js': ['firebase-messaging-sw.js', 'text/javascript'] };
    const f = files[url.pathname];
    if (!f) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', f[1]);
    return res.end(fs.readFileSync(path.join(root, f[0])));
  }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
    req.query = Object.fromEntries(url.searchParams);
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = b => res.end(b);
    fn(req, res);
  });
}).listen(port, () => console.log('MPC dev server on http://localhost:' + port));
