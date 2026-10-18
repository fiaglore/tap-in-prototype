// Apple Wallet (.pkpass) and Google Wallet ("Save to Google Wallet" link) passes. Both carry the same code the Tap In
// pass shows, so the gate treats them the same. Each is switched on only when its credentials are set (see README).
import { base64url } from './util.js';
import { zip } from './zip.js';
import { importRsaKey, pemToDer, signDetached } from './cms.js';

const enc = new TextEncoder();
export const walletConfig = (env) => ({
  apple: !!(env.APPLE_PASS_TYPE_ID && env.APPLE_TEAM_ID && env.APPLE_PASS_CERT && env.APPLE_PASS_KEY && env.APPLE_WWDR_CERT),
  google: !!(env.GOOGLE_WALLET_ISSUER_ID && env.GOOGLE_WALLET_SERVICE_ACCOUNT)
});

const lagos = (sec, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', ...opts }).format(new Date(sec * 1000));
const w3c = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// What goes on the card, from a pass, an invitation or a visitor pass.
//   d: { serial, kind: 'event'|'office'|'invite'|'visitor', title, holder, type, code, venue, city, starts_at,
//        party, table, host, valid_from, valid_until, voided }
function fields(d) {
  const when = d.kind === 'visitor' && d.valid_from
    ? `${lagos(d.valid_from, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} to ${lagos(d.valid_until, { hour: '2-digit', minute: '2-digit' })}`
    : d.starts_at ? lagos(d.starts_at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const where = [d.venue, d.city].filter(Boolean).join(', ') || null;
  return {
    titleLabel: d.kind === 'visitor' ? 'VISITOR PASS' : d.kind === 'office' ? 'ACCESS' : d.kind === 'invite' ? 'YOU ARE INVITED' : 'EVENT',
    typeLabel: d.kind === 'office' || d.kind === 'visitor' ? 'GROUP' : 'TICKET',
    extra: [
      when && ['when', d.kind === 'visitor' ? 'VALID' : 'WHEN', when],
      where && ['where', 'WHERE', where],
      d.party > 1 && ['party', 'PARTY', `${d.party} people`],
      d.table && ['table', 'TABLE', d.table],
      d.host && ['host', 'VISITING', d.host]
    ].filter(Boolean)
  };
}

// ---- Apple ----------------------------------------------------------------------------------------------
async function sha1Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function applePass(env, d, images) {
  const f = fields(d);
  const style = d.kind === 'event' || d.kind === 'invite' ? 'eventTicket' : 'generic';
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    serialNumber: d.serial,
    organizationName: 'Tap In',
    description: `${d.title} · Tap In`,
    logoText: 'Tap In',
    foregroundColor: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(43, 27, 45)',
    labelColor: 'rgb(201, 184, 212)',
    [style]: {
      primaryFields: [{ key: 'title', label: f.titleLabel, value: d.title }],
      secondaryFields: [{ key: 'name', label: 'NAME', value: d.holder }, ...(d.type ? [{ key: 'type', label: f.typeLabel, value: d.type }] : [])],
      auxiliaryFields: f.extra.map(([key, label, value]) => ({ key, label, value })),
      backFields: [
        { key: 'how', label: 'At the door', value: 'Show the QR code to be scanned. If it will not scan, staff can type the code below.' },
        { key: 'code', label: 'Code', value: d.code },
        { key: 'by', label: 'Issued by', value: 'Tap In · tap-in.world' }
      ]
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: d.code, messageEncoding: 'iso-8859-1', altText: d.code }],
    barcode: { format: 'PKBarcodeFormatQR', message: d.code, messageEncoding: 'iso-8859-1', altText: d.code },
    ...(d.starts_at ? { relevantDate: w3c(d.starts_at) } : {}),
    ...(d.valid_until ? { expirationDate: w3c(d.valid_until) } : {}),
    ...(d.voided ? { voided: true } : {})
  };
  const files = [{ name: 'pass.json', data: enc.encode(JSON.stringify(pass)) }, ...images];
  const manifest = {};
  for (const file of files) manifest[file.name] = await sha1Hex(file.data);
  const manifestBytes = enc.encode(JSON.stringify(manifest));
  const signature = await signDetached(manifestBytes, {
    signerCertDer: pemToDer(env.APPLE_PASS_CERT, 'CERTIFICATE'),
    extraCertsDer: [pemToDer(env.APPLE_WWDR_CERT, 'CERTIFICATE')],
    key: await importRsaKey(env.APPLE_PASS_KEY)
  });
  return zip([...files, { name: 'manifest.json', data: manifestBytes }, { name: 'signature', data: signature }]);
}

// ---- Google ---------------------------------------------------------------------------------------------
const b64urlJson = (o) => base64url(enc.encode(JSON.stringify(o)));
const safeId = (s) => String(s).replace(/[^\w.-]/g, '_');

export async function googleSaveUrl(env, d, origin) {
  const sa = JSON.parse(env.GOOGLE_WALLET_SERVICE_ACCOUNT);
  const issuer = env.GOOGLE_WALLET_ISSUER_ID;
  const f = fields(d);
  const classId = `${issuer}.tapin_pass`;
  const object = {
    id: `${issuer}.${safeId(d.serial)}`,
    classId,
    state: d.voided ? 'INACTIVE' : 'ACTIVE',
    hexBackgroundColor: '#2B1B2D',
    logo: { sourceUri: { uri: origin + '/wallet/google-logo.png' }, contentDescription: { defaultValue: { language: 'en', value: 'Tap In' } } },
    cardTitle: { defaultValue: { language: 'en', value: 'Tap In' } },
    subheader: { defaultValue: { language: 'en', value: f.titleLabel } },
    header: { defaultValue: { language: 'en', value: d.title } },
    textModulesData: [['name', 'Name', d.holder], ...(d.type ? [['type', f.typeLabel === 'GROUP' ? 'Group' : 'Ticket', d.type]] : []), ...f.extra.map(([k, l, v]) => [k, l.charAt(0) + l.slice(1).toLowerCase(), v])]
      .map(([id, header, body]) => ({ id, header, body })),
    barcode: { type: 'QR_CODE', value: d.code, alternateText: d.code },
    ...(d.valid_until ? { validTimeInterval: { end: { date: new Date(d.valid_until * 1000).toISOString() } } } : {})
  };
  const claims = { iss: sa.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000), origins: [origin], payload: { genericClasses: [{ id: classId }], genericObjects: [object] } };
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  const key = await importRsaKey(sa.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned)));
  return `https://pay.google.com/gp/v/save/${unsigned}.${base64url(sig)}`;
}
