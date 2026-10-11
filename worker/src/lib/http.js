import { HttpError } from './util.js';

const BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE, ...headers } });
}

export async function readJson(request, maxBytes = 65536) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send the request as JSON.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
  try {
    const v = JSON.parse(text || '{}');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
}

export function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';

// Reject cross-site writes. Browsers always send Origin on cross-site POST/PATCH/DELETE.
export function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('Origin');
  if (!origin) return;
  let ok = false;
  try {
    ok = new URL(origin).host === new URL(request.url).host;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed.');
}
