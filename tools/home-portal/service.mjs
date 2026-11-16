#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.PORTAL_HOST || '127.0.0.1';
const PORT = Number(process.env.PORTAL_PORT || 8080);

const server = createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    .pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'home-portal' }));
    return;
  }

  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  createReadStream(join(__dirname, 'public', 'index.html')).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`home portal listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
