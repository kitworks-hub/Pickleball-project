/* Local test server: serves index.html and runs the /api functions with the same handlers Vercel uses.
   With no Redis variables set it keeps data in memory (lost when it stops).
   Usage: node scripts/dev-server.js [port] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 3000;
const api = { '/api/auth': require('../api/auth'), '/api/data': require('../api/data') };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = api[url.pathname];
  if (!fn) {
    if (url.pathname !== '/' && url.pathname !== '/index.html') { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(fs.readFileSync(path.join(root, 'index.html')));
  }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
    req.query = Object.fromEntries(url.searchParams);
    res.status = c => { res.statusCode = c; return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    fn(req, res);
  });
}).listen(port, () => console.log('MPC dev server on http://localhost:' + port));
