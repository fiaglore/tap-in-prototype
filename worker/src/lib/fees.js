// Who pays what on a ticket order (dossier 7.5, 16A). All integer kobo; no floating point reaches money.
//
//   subtotal   = unit price x qty
//   commission = round(subtotal x PLATFORM_COMMISSION_BPS / 10000) + PLATFORM_FLAT_KOBO x qty   (free tickets: 0)
//   fee_mode "pass":   buyer pays subtotal + commission; organiser is owed the full subtotal.
//   fee_mode "absorb": buyer pays subtotal; organiser is owed subtotal - commission.
//   The payment provider's own fee is reported by the provider and recorded as a cost; it is not taken from the organiser.
//   (That is a business decision: change organiserPayable here if processor fees should be shared.)
import { HttpError } from './util.js';

const intVar = (v) => (v === undefined || v === null || v === '' ? null : Number.parseInt(v, 10));

// Returns null if the commission has not been configured: a paid checkout must not open with an unknown fee.
export function feeConfig(env) {
  const bps = intVar(env.PLATFORM_COMMISSION_BPS);
  const flat = intVar(env.PLATFORM_FLAT_KOBO) ?? 0;
  if (bps === null || !Number.isInteger(bps) || bps < 0 || bps > 5000 || !Number.isInteger(flat) || flat < 0) return null;
  return { bps, flat };
}

export function priceOrder(env, { unitKobo, qty, feeMode }) {
  const cfg = feeConfig(env);
  if (!cfg) throw new HttpError(503, 'fees_not_configured', 'Ticket fees have not been set up yet, so paid checkout is closed.');
  const subtotal = unitKobo * qty;
  const commission = subtotal === 0 ? 0 : Math.round((subtotal * cfg.bps) / 10000) + cfg.flat * qty;
  const buyerFee = feeMode === 'pass' ? commission : 0;
  return {
    subtotal_kobo: subtotal,
    commission_kobo: commission,
    buyer_fee_kobo: buyerFee,
    total_kobo: subtotal + buyerFee,
    organiser_payable_kobo: feeMode === 'pass' ? subtotal : Math.max(0, subtotal - commission)
  };
}
