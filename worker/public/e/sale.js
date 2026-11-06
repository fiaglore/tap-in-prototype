// Public ticket sales page. Anyone can see prices; buying needs a signed-in session so the ticket has somewhere to land.
// Free tickets are claimed straight away. Paid tickets go to the payment provider's checkout and arrive only when the
// provider confirms payment to our server (never because the browser came back), so this page waits and asks the server.
import { h, mount, toast, when } from '/js/dom.js';
import { get, post, put } from '/js/api.js';
import { selfieModal } from '/js/selfie.js';
import { signInFlow } from '/js/auth-ui.js';

const root = document.getElementById('root');
const eventId = new URLSearchParams(location.search).get('id');

let checkoutMode = 'off'; // from /api/config: off | demo | mock | live
const isDemo = () => checkoutMode === 'demo' || checkoutMode === 'mock';
const naira = (kobo) => (kobo > 0 ? '₦' + (kobo / 100).toLocaleString('en-NG') : 'Free');

function fail(message) {
  mount(root, h('h2', {}, 'Can’t open this page'), h('p', { class: 'muted', style: 'margin-top:6px' }, message),
    h('a', { class: 'btn primary block', style: 'margin-top:16px', href: '/' }, 'Back home'));
}

function confirmed(tierName, extraCodes) {
  mount(root,
    h('p', { class: 'eyebrow' }, isDemo() ? 'Purchase complete (demo)' : 'Purchase complete'),
    h('h2', { style: 'margin-top:6px' }, 'You’re in — ' + tierName),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Your ticket was added to your account. Open the app to see your QR pass.'),
    h('a', { class: 'btn primary block', style: 'margin-top:16px', href: '/app/' }, 'Open my pass'),
    extraCodes.length > 0 && h('div', { class: 'card', style: 'margin-top:18px' },
      h('h3', {}, `${extraCodes.length} more code${extraCodes.length === 1 ? '' : 's'} from this purchase`),
      h('p', { class: 'hint', style: 'margin-top:4px' }, 'Send one to each person you bought a ticket for. They add it in the app under their own account.'),
      h('div', { class: 'stack', style: 'margin-top:10px' }, extraCodes.map((c) => h('div', { class: 'input code', style: 'user-select:all' }, c)))));
}

// A failed purchase never leaves the page: the tickets are reloaded (stock may have moved) and the
// reason is shown under the ticket type that was being bought.
async function backToTickets(ev, tierId, message, qty) {
  let fresh = ev;
  try { fresh = await get(`/public/events/${ev.event.id}`); } catch { /* keep what we had */ }
  tierPage(fresh, { tierId, message, qty });
}

function buyFlow(ev, tier, qty, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Getting your ticket…'; }
  const run = async () => {
    try {
      const r = await post(`/public/events/${ev.event.id}/buy`, { tier_id: tier.id, qty });
      confirmed(tier.name, r.extra_codes || []);
    } catch (ex) {
      if (ex.code === 'photo_required') {
        // This event checks passes against a photo of the holder.
        const shot = await selfieModal({ title: 'Add your photo', note: 'This event checks tickets against a photo of you at the door.' });
        if (shot) { try { await put('/me/photo', { image: shot }); return run(); } catch (e2) { ex = e2; } }
        else return backToTickets(ev, tier.id, 'This event needs a photo of you before you can get a ticket.', qty);
      }
      if (ex.status === 401) {
        signInFlow(root, {
          title: 'Sign in to get your ticket',
          lede: `We need a phone number or email so your ${tier.name} ticket has somewhere to go.`,
          onDone: run
        });
      } else {
        backToTickets(ev, tier.id, ex.message, qty);
      }
    }
  };
  run();
}

const money = (k) => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: k % 100 ? 2 : 0 });

// Paid ticket: ask the server for a price (with any discount code), then send the buyer to the provider's checkout.
function payFlow(ev, tier, qty, codeText, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout…'; }
  const run = async () => {
    try {
      const r = await post(`/public/events/${ev.event.id}/checkout`, { tier_id: tier.id, qty, ...(codeText ? { discount_code: codeText } : {}) });
      if (checkoutMode === 'mock') return backToTickets(ev, tier.id, 'Test mode: order ' + r.order.id + ' is waiting for a test payment confirmation.', qty);
      location.href = r.checkout_url;
    } catch (ex) {
      if (ex.code === 'photo_required') {
        const shot = await selfieModal({ title: 'Add your photo', note: 'This event checks tickets against a photo of you at the door.' });
        if (shot) { try { await put('/me/photo', { image: shot }); return run(); } catch (e2) { ex = e2; } }
        else return backToTickets(ev, tier.id, 'This event needs a photo of you before you can get a ticket.', qty);
      }
      if (ex.status === 401) signInFlow(root, { title: 'Sign in to buy your ticket', lede: `We need a phone number or email so your ${tier.name} ticket has somewhere to go.`, onDone: run });
      else backToTickets(ev, tier.id, ex.message, qty);
    }
  };
  run();
}

// Shows what the buyer would pay for this quantity and code, before they commit.
async function showQuote(ev, tier, qty, codeText, out) {
  mount(out, h('span', { class: 'muted' }, 'Checking…'));
  try {
    const { quote } = await post(`/public/events/${ev.event.id}/quote`, { tier_id: tier.id, qty, ...(codeText ? { discount_code: codeText } : {}) });
    mount(out,
      quote.discount_kobo > 0 && h('div', { class: 'muted' }, 'Discount: −' + money(quote.discount_kobo)),
      quote.fee_kobo > 0 && h('div', { class: 'muted' }, 'Service fee: ' + money(quote.fee_kobo)),
      h('div', { style: 'font-weight:700' }, 'Total: ' + money(quote.total_kobo)));
  } catch (ex) {
    mount(out, h('div', { class: 'error', role: 'alert' }, ex.message));
  }
}

// Back from the provider (?order=...): wait for the server to confirm the payment, then show the ticket.
async function waitForOrder(orderId) {
  mount(root, h('p', { class: 'eyebrow' }, 'Payment'), h('h2', { style: 'margin-top:6px' }, 'Confirming your payment…'),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'This usually takes a few seconds. Please keep this page open.'));
  for (let i = 0; i < 40; i++) {
    let r;
    try { r = await get('/orders/' + encodeURIComponent(orderId)); } catch (ex) {
      if (ex.status === 401) return signInFlow(root, { title: 'Sign in to see your ticket', lede: 'Sign in with the phone number or email you bought with.', onDone: () => waitForOrder(orderId) });
      return fail(ex.message);
    }
    const st = r.order.status;
    if (st === 'fulfilled') return confirmed(`${r.order.qty} ticket${r.order.qty === 1 ? '' : 's'}`, []);
    if (['failed', 'expired'].includes(st)) return fail('The payment did not go through, so no ticket was issued and you have not been charged for one. You can try again from the event page.');
    if (['review', 'refund_due', 'refunding', 'refunded'].includes(st)) return fail('There was a problem with this order. If money left your account it will be returned. Contact support with order ' + orderId + '.');
    await new Promise((res) => setTimeout(res, 3000));
  }
  fail('We have not heard back from your bank yet. If you were charged, your ticket will appear in the app shortly. Order ' + orderId + '.');
}

// The quantity menu never offers more than are left (when the server says how many that is).
const MAX_QTY = 8;
const maxQty = (t) => Math.max(1, Math.min(MAX_QTY, t.left === null || t.left === undefined ? MAX_QTY : t.left));

// Inside the phone app: the phone's own share sheet; anywhere else (or if it fails) the link is copied.
async function shareEvent(e) {
  const url = location.origin + '/e/?id=' + encodeURIComponent(eventId);
  if (window.TapInNative && (await window.TapInNative.share({ title: e.name, text: 'Tickets for ' + e.name + ' on Tap In', url }))) return;
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
}

function tierPage(ev, notice = null) {
  document.title = ev.event.name + ' · Tap In';
  const when_ = [ev.event.venue, ev.event.city, ev.event.starts_at && when(ev.event.starts_at)].filter(Boolean).join(' · ');
  mount(root,
    isDemo() && h('p', { class: 'eyebrow' }, 'Demo checkout — no real payment is taken'),
    h('h1', { style: 'font-size:30px;margin-top:4px' }, ev.event.name),
    when_ && h('p', { class: 'muted', style: 'margin-top:4px' }, when_),
    window.TapInNative && h('button', { class: 'btn ghost small sharebtn', type: 'button', onclick: () => shareEvent(ev.event) }, 'Share this event'),
    ev.event.sales === 'upcoming' && h('div', { class: 'notice warn', style: 'margin-top:14px' }, 'Tickets are not on sale yet' + (ev.event.sales_start ? '. Sales open ' + when(ev.event.sales_start) + '.' : '.')),
    ev.event.sales === 'closed' && h('div', { class: 'notice warn', style: 'margin-top:14px' }, 'Ticket sales for this event have closed.'),
    h('div', { class: 'stack', style: 'margin-top:20px' }, ev.tiers.map((t) => {
      const top = maxQty(t);
      const want = notice && notice.tierId === t.id && notice.qty ? Math.min(notice.qty, top) : 1;
      const qty = h('select', { class: 'input qty', 'aria-label': `Quantity for ${t.name}` },
        Array.from({ length: top }, (_, k) => k + 1).map((n) => h('option', { value: n, selected: n === want }, String(n))));
      const canBuy = ev.event.sales === 'open' && !t.sold_out;
      const paying = canBuy && t.price_kobo > 0 && (checkoutMode === 'live' || checkoutMode === 'mock');
      const code = paying && h('input', { class: 'input', placeholder: 'Discount code', 'aria-label': 'Discount code', autocomplete: 'off', style: 'max-width:180px;text-transform:uppercase' });
      const quoteOut = paying && h('div', { style: 'margin-top:8px' });
      const err = notice && notice.tierId === t.id && notice.message;
      return h('div', { class: 'card' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('div', {}, h('div', { style: 'font-weight:700' }, t.name),
            h('div', { class: 'muted' }, naira(t.price_kobo)),
            t.sold_out ? h('div', { class: 'chip bad', style: 'margin-top:6px' }, 'Sold out') : t.left !== null && t.left > 0 && h('div', { class: 'chip', style: 'margin-top:6px' }, 'Only ' + t.left + ' left')),
          canBuy && (t.price_kobo > 0 && checkoutMode === 'off'
            ? h('span', { class: 'chip' }, 'Online payment opens soon')
            : h('div', { class: 'row buyrow' }, qty,
              h('button', { class: 'btn primary', type: 'button', onclick: (e) => {
                const n = Number.parseInt(qty.value, 10);
                if (t.price_kobo > 0 && !isDemo() || checkoutMode === 'mock' && t.price_kobo > 0) payFlow(ev, t, n, code && code.value.trim(), e.currentTarget);
                else buyFlow(ev, t, n, e.currentTarget);
              } }, t.price_kobo > 0 ? 'Pay' : 'Get ticket')))),
        paying && h('div', { class: 'row', style: 'margin-top:10px;gap:8px' }, code,
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => showQuote(ev, t, Number.parseInt(qty.value, 10), code.value.trim(), quoteOut) }, 'Apply')),
        paying && quoteOut,
        err && h('div', { class: 'error', role: 'alert' }, err));
    })),
    ev.tiers.length === 0 && h('p', { class: 'muted', style: 'margin-top:12px' }, 'Tickets for this event are not on sale yet.'));
}

if (!eventId) {
  fail('This link is missing an event. Ask the organiser for the sales page link again.');
} else {
  const orderId = new URLSearchParams(location.search).get('order');
  get('/config').catch(() => ({})).then((c) => { checkoutMode = c.checkout || 'off'; })
    .then(() => (orderId ? waitForOrder(orderId) : get(`/public/events/${eventId}`).then(tierPage)))
    .catch((ex) => fail(ex.message));
}
