// A detached CMS (PKCS #7) signature, as Apple Wallet requires for a .pkpass manifest, built with WebCrypto.
// Just enough DER: writing the SignedData structure and reading a certificate's issuer and serial number.
import { concat } from './zip.js';

const enc = new TextEncoder();
const lenBytes = (n) => { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n = Math.floor(n / 256); } return [0x80 | b.length, ...b]; };
const tlv = (tag, ...parts) => { const body = concat(parts); return concat([Uint8Array.from([tag, ...lenBytes(body.length)]), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const ctx0 = (...p) => tlv(0xa0, ...p);
const NULL = Uint8Array.from([5, 0]);
const int = (n) => tlv(0x02, Uint8Array.from([n]));
const octets = (b) => tlv(0x04, b);
function oid(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) { const b = [v & 127]; let x = Math.floor(v / 128); while (x) { b.unshift((x & 127) | 128); x = Math.floor(x / 128); } out.push(...b); }
  return tlv(0x06, Uint8Array.from(out));
}
const OID = { data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', sha256: '2.16.840.1.101.3.4.2.1', rsa: '1.2.840.113549.1.1.1', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5' };
const utcTime = (d) => { const p = (n) => String(n).padStart(2, '0'); return tlv(0x17, enc.encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };

// Read one TLV: where its header ends and its body ends.
function read(buf, at) {
  let len = buf[at + 1], head = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]; head = 2 + n; }
  return { tag: buf[at], start: at + head, end: at + head + len, raw: buf.subarray(at, at + head + len) };
}
// A certificate's issuer Name and serial number, exactly as encoded (for the signer identifier).
export function certIssuerSerial(der) {
  const tbs = read(der, read(der, 0).start);
  let at = tbs.start;
  let el = read(der, at);
  if (el.tag === 0xa0) { at = el.end; el = read(der, at); } // optional explicit version
  const serial = el.raw;
  const alg = read(der, el.end);
  const issuer = read(der, alg.end).raw;
  return { issuer, serial };
}

export function pemToDer(pem, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(String(pem || ''));
  if (!m) return null;
  const bin = atob(m[1].replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
// RSA private key from PEM: PKCS #8 ("PRIVATE KEY") or PKCS #1 ("RSA PRIVATE KEY", wrapped into PKCS #8).
export async function importRsaKey(pem) {
  let der = pemToDer(pem, 'PRIVATE KEY');
  if (!der) {
    const pkcs1 = pemToDer(pem, 'RSA PRIVATE KEY');
    if (!pkcs1) throw new Error('No RSA private key found');
    der = seq(int(0), seq(oid(OID.rsa), NULL), octets(pkcs1));
  }
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

const cmpBytes = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

// Detached SignedData over `content`, signed by `signerCertDer` + `key`, carrying the extra certificates (Apple's WWDR).
export async function signDetached(content, { signerCertDer, extraCertsDer = [], key, now = new Date() }) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
  const attrs = [
    seq(oid(OID.contentType), set(oid(OID.data))),
    seq(oid(OID.signingTime), set(utcTime(now))),
    seq(oid(OID.messageDigest), set(octets(digest)))
  ].sort(cmpBytes); // DER: a SET OF is sorted by encoding
  const signedAttrsBody = concat(attrs);
  const toSign = tlv(0x31, signedAttrsBody); // signed as a SET...
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, toSign));
  const { issuer, serial } = certIssuerSerial(signerCertDer);
  const sha256Alg = seq(oid(OID.sha256), NULL);
  const signerInfo = seq(int(1), seq(issuer, serial), sha256Alg, tlv(0xa0, signedAttrsBody) /* ...stored as [0] IMPLICIT */, seq(oid(OID.rsa), NULL), octets(signature));
  const signedData = seq(int(1), set(sha256Alg), seq(oid(OID.data)), ctx0(signerCertDer, ...extraCertsDer), set(signerInfo));
  return seq(oid(OID.signedData), ctx0(signedData));
}
