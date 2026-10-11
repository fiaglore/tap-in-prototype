// Runs the real Worker code in-process against the SQLite-backed D1 stand-in.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';
import { createD1 } from './d1-shim.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const schema = readFileSync(join(root, 'migrations/0001_init.sql'), 'utf8');
export const PEPPER = 'test-pepper-0123456789-0123456789-0123456789';

export function makeEnv(extra = {}) {
  return {
    DB: createD1(schema),
    SECRET_PEPPER: PEPPER,
    OTP_MODE: 'demo',
    ORGANISER_IDENTIFIERS: '',
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ...extra
  };
}

// A browser-like client: keeps its own cookie jar and source address.
export function client(env, ip = '10.0.0.1') {
  let cookie = '';
  async function call(method, path, { body, headers = {}, raw } = {}) {
    const h = { 'CF-Connecting-IP': ip, ...headers };
    if (cookie) h.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      payload = raw ? body : JSON.stringify(body);
    }
    const res = await worker.fetch(new Request('https://tapin.test' + path, { method, headers: h, body: payload }), env, {
      waitUntil() {}
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = /Max-Age=0/i.test(set) ? '' : pair;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, body: data, headers: res.headers, setCookie: set };
  }
  return {
    get: (p, o) => call('GET', p, o),
    post: (p, body, o) => call('POST', p, { body, ...o }),
    patch: (p, body, o) => call('PATCH', p, { body, ...o }),
    call,
    ip
  };
}

// Sign a person in through the real OTP flow (demo mode returns the code).
export async function signIn(env, identifier, ip, name) {
  const c = client(env, ip);
  const r = await c.post('/api/auth/otp/request', { identifier });
  if (r.status !== 200) throw new Error('otp request failed: ' + JSON.stringify(r.body));
  const v = await c.post('/api/auth/otp/verify', { identifier, code: r.body.dev_code });
  if (v.status !== 200) throw new Error('otp verify failed: ' + JSON.stringify(v.body));
  if (name) await c.patch('/api/me', { name });
  return c;
}
