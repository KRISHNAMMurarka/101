import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../../release/console-receiver/web/', import.meta.url));
const port = Number(process.env.RECEIVER_PORT ?? 4177);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('RECEIVER_PORT must be between 1024 and 65535.');
readFileSync(join(directory, 'index.html'));
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method !== 'GET' || url.search || !/^\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))?$/.test(url.pathname)) { response.writeHead(404).end(); return; }
  const file = resolve(directory, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  try { const body = readFileSync(file); response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store'); response.end(body); }
  catch { response.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local receiver ready at http://127.0.0.1:${port}`));
const close = () => { server.closeAllConnections(); server.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
