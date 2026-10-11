// Local stand-in for `wrangler dev`: serves /public with the _headers file applied and runs the real Worker
// against a SQLite-backed D1 stand-in. Usage: node test/dev-server.mjs [port]
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { makeEnv } from './harness.mjs';

const pub = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const headerLines = readFileSync(join(pub, '_headers'), 'utf8').split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]);
const env = makeEnv();

async function assets(request) {
  let p = decodeURIComponent(new URL(request.url).pathname);
  let file = normalize(join(pub, p));
  if (!file.startsWith(pub)) return new Response('no', { status: 400 });
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    return new Response(readFileSync(join(pub, '404.html')), { status: 404, headers: { 'content-type': types['.html'] } });
  }
  return new Response(readFileSync(file), { headers: { 'content-type': types[extname(file)] || 'application/octet-stream' } });
}
env.ASSETS = { fetch: assets };

const port = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(req.headers);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await worker.fetch(request, env, { waitUntil() {} });
  const out = {};
  response.headers.forEach((v, k) => (out[k] = v));
  const cookie = response.headers.get('set-cookie');
  if (cookie) out['set-cookie'] = cookie;
  for (const [k, v] of headerLines) out[k.toLowerCase()] = v;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log('Tap In dev server on http://localhost:' + port));
