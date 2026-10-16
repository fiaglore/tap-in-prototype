// Tiny element builder. Everything the server sends goes in as text nodes, never as HTML.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export function mount(root, ...kids) {
  root.replaceChildren();
  add(root, kids);
}
export function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
export async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Copy is blocked here. Select the text instead.');
  }
}
export const when = (sec, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (sec ? new Date(sec * 1000).toLocaleString(undefined, opts) : '');
export const ago = (sec) => {
  const d = Math.max(0, Math.round(Date.now() / 1000 - sec));
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  return when(sec);
};
export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The Tap In lettering from the logo, drawn as SVG so it follows the light/dark theme.
export function wordmarkText() {
  const s = document.createElement('span');
  s.innerHTML = '<svg class="wm" viewBox="0 0 600 151" role="img" aria-label="Tap In"><polygon points="0,0 76,0 76,151 45,151 45,26 0,26"/><polygon points="80,0 120,0 120,26 93,26"/><polygon points="149,0 181,0 244,151 212,151 201,124 131,124 120,151 88,151"/><polygon points="143,97 189,97 166,42" class="wm-cut"/><polygon points="164,44 193,21 198,27 169,50" class="wm-cut"/><rect x="251" y="0" width="29" height="151"/><path d="M280,0 H320 A53,53 0 0 1 320,106 H301 L285,76 H318 A25,25 0 0 0 318,26 H280 Z"/><g class="wm-n" transform="translate(426,0)"><polygon points="0,0 31,0 31,26 0,38"/><rect x="0" y="44" width="31" height="107"/><polygon points="45,0 77,0 174,139 174,151 142,151 77,58 77,151 45,151"/><polygon points="142,0 174,0 174,113 142,90"/></g></svg>';
  return s.firstChild;
}
