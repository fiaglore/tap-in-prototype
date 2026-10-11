// The personal Tap In card: appearance only. It is stored on this device (localStorage) and never affects access.
import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const HEX = /^#[0-9A-Fa-f]{6}$/;

export const PRESETS = {
  Plum: { c1: '#6C4A6C', c2: '#2B1B2D', pat: 'arcs', fin: 'matte', type: 'bold' },
  Lilac: { c1: '#B5A0CC', c2: '#6C4A6C', pat: 'dots', fin: 'grain', type: 'bold' },
  Midnight: { c1: '#2B1B2D', c2: '#463049', pat: 'lines', fin: 'matte', type: 'light' },
  Mist: { c1: '#EFE7F4', c2: '#B5A0CC', pat: 'split', fin: 'gloss', type: 'light' },
  Signal: { c1: '#80619A', c2: '#2B1B2D', pat: 'split', fin: 'gloss', type: 'bold' }
};
export const SWATCHES = ['#6C4A6C', '#B5A0CC', '#2B1B2D', '#80619A', '#EFE7F4', '#463049', '#3A263D', '#C9B8D4'];
export const FINISHES = ['matte', 'gloss', 'grain'];
export const PATTERNS = ['none', 'split', 'arcs', 'lines', 'dots'];
export const TYPES = ['bold', 'light'];

const KEY = 'tapin-card';

export function sanitise(c) {
  const base = PRESETS.Plum;
  const o = { ...base };
  if (c && typeof c === 'object') {
    if (HEX.test(c.c1)) o.c1 = c.c1;
    if (HEX.test(c.c2)) o.c2 = c.c2;
    if (PATTERNS.includes(c.pat)) o.pat = c.pat;
    if (FINISHES.includes(c.fin)) o.fin = c.fin;
    if (TYPES.includes(c.type)) o.type = c.type;
    if (typeof c.name === 'string') o.name = c.name.replace(/[\u0000-\u001f]/g, '').slice(0, 16);
  }
  return o;
}
export function loadCard() {
  try { return sanitise(JSON.parse(localStorage.getItem(KEY))); } catch { return sanitise(null); }
}
export function saveCard(c) {
  try { localStorage.setItem(KEY, JSON.stringify(sanitise(c))); return true; } catch { return false; }
}

const lum = (hex) => (parseInt(hex.slice(1, 3), 16) * 0.3 + parseInt(hex.slice(3, 5), 16) * 0.59 + parseInt(hex.slice(5, 7), 16) * 0.11) / 255;

function background(c) {
  const P = {
    arcs: 'radial-gradient(circle at 100% 0,transparent 38%,rgba(255,255,255,.16) 38.5%,transparent 40%,transparent 54%,rgba(255,255,255,.1) 54.5%,transparent 56%)',
    split: 'linear-gradient(115deg,transparent 54%,rgba(255,255,255,.14) 54%)',
    lines: 'repeating-linear-gradient(115deg,rgba(255,255,255,.09) 0 2px,transparent 2px 14px)',
    dots: 'radial-gradient(rgba(255,255,255,.18) 1.5px,transparent 2px) 0 0/14px 14px'
  };
  const F = {
    gloss: 'linear-gradient(115deg,rgba(255,255,255,.25),transparent 45%)',
    grain: 'repeating-linear-gradient(0deg,rgba(0,0,0,.06) 0 1px,transparent 1px 3px)'
  };
  return [F[c.fin], P[c.pat], `linear-gradient(135deg,${c.c1},${c.c2})`].filter(Boolean).join(',');
}

function tapIcon() {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '22');
  s.setAttribute('height', '22');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.7');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M7 8c2 2.5 2 5.5 0 8M11 5c3.5 3.5 3.5 10.5 0 14M15 3c5 5 5 13 0 18');
  s.append(p);
  return s;
}

// card: sanitised style; info: { name, num, status }
export function cardEl(card, info) {
  const c = sanitise(card);
  const fg = lum(c.c1) > 0.6 ? '#2B1B2D' : '#FFFFFF';
  return h('div', { class: 'tc', style: `color:${fg};background:${background(c)}`, role: 'img', 'aria-label': `Tap In card for ${info.name}` },
    h('div', { class: 'r1' }, h('span', { class: 'ico' }, tapIcon()), h('span', { class: 'cstat' }, h('i', { class: 'dt' }), info.status)),
    h('div', { class: 'r1 bot' }, h('div', { class: 'cname', style: `font-weight:${c.type === 'light' ? 300 : 800}` }, info.name), h('div', { class: 'cnum' }, info.num)));
}

export const cardNumber = (userId) => 'TI •••• ' + String(userId || '').slice(-4).toUpperCase();
