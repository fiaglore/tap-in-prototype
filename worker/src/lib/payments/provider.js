// Payment provider interface. Every provider (Paystack, Flutterwave, Interswitch, ...) implements:
//
//   initialize(env, { order, email, callbackUrl }) -> { checkout_url, provider_ref? }
//   parseWebhook(env, rawBody, headers) -> { event_key, type, provider_ref, amount_kobo, currency, processor_fee_kobo }
//        Must verify the provider's signature over the RAW body and throw HttpError(401) if it is wrong.
//        type is one of 'charge.success' | 'charge.failed' | 'refund.processed' | 'other'.
//   refund(env, { provider_ref, amount_kobo, order_id }) -> { refund_ref }
//
// A ticket is never issued from a browser redirect or an uploaded screenshot, only from a verified webhook.
// No real provider is connected yet. "mock" exists for tests and local development and is refused in live mode.
import { HttpError, hmacHex, safeEqual } from '../util.js';

const mock = {
  name: 'mock',
  async initialize(env, { order }) {
    return { checkout_url: `https://mock-pay.invalid/pay/${order.provider_ref}` };
  },
  async parseWebhook(env, raw, headers) {
    const secret = env.PAYMENT_WEBHOOK_SECRET;
    if (!secret || secret.length < 16) throw new HttpError(503, 'webhook_not_configured', 'Payment webhooks are not configured.');
    const sig = String(headers.get('x-mock-signature') || '');
    const want = await hmacHex(secret, raw);
    if (!sig || !safeEqual(sig, want)) throw new HttpError(401, 'bad_signature', 'Webhook signature is not valid.');
    let b;
    try { b = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'Webhook body is not valid JSON.'); }
    return {
      event_key: String(b.id || ''),
      type: ['charge.success', 'charge.failed', 'refund.processed'].includes(b.type) ? b.type : 'other',
      provider_ref: String(b.ref || ''),
      amount_kobo: Number.isInteger(b.amount_kobo) ? b.amount_kobo : null,
      currency: String(b.currency || 'NGN'),
      processor_fee_kobo: Number.isInteger(b.processor_fee_kobo) ? b.processor_fee_kobo : 0
    };
  },
  async refund(env, { provider_ref }) {
    if (env.MOCK_REFUND_FAIL === '1') throw new HttpError(502, 'refund_failed', 'The payment provider could not refund this payment.');
    return { refund_ref: 'mock-refund-' + provider_ref };
  }
};

const PROVIDERS = { mock };

export const checkoutMode = (env) => {
  const m = String(env.TICKET_CHECKOUT || 'off').toLowerCase();
  return ['demo', 'mock', 'live'].includes(m) ? m : 'off';
};

// "mock" mode (development and tests) uses the mock provider. "live" uses PAYMENT_PROVIDER, which must be a real adapter.
export function getProvider(env, nameFromUrl = null) {
  const mode = checkoutMode(env);
  const name = nameFromUrl || (mode === 'mock' ? 'mock' : String(env.PAYMENT_PROVIDER || '').toLowerCase());
  const p = PROVIDERS[name];
  if (!p) throw new HttpError(503, 'payment_not_connected', 'Online payment is not open yet.');
  if (name === 'mock' && mode === 'live') throw new HttpError(503, 'payment_not_connected', 'Online payment is not open yet.');
  if (name === 'mock' && mode !== 'mock') throw new HttpError(404, 'not_found', 'Not found.');
  return p;
}
