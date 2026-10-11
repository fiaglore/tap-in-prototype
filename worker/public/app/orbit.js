// "Around me": your passes orbit you, closer when the event is sooner.
const NS = 'http://www.w3.org/2000/svg';
const C = 170;
const RINGS = [34, 70, 108, 146];

export const daysTo = (sec) => (sec ? Math.ceil((sec * 1000 - Date.now()) / 864e5) : null);
const ringOf = (d) => (d === null ? 3 : d <= 0 ? 0 : d <= 7 ? 1 : d <= 30 ? 2 : 3);

function el(name, attrs, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
const short = (s) => (s.length > 16 ? s.slice(0, 15) + '…' : s);

export function orbitSvg(passes, selected, onSelect) {
  const svg = el('svg', { viewBox: '0 0 340 340', role: 'group', 'aria-label': 'Your passes by how soon the event is' });
  [['THIS WEEK', 1], ['THIS MONTH', 2], ['LATER', 3]].forEach(([label, k]) => {
    svg.append(el('circle', { cx: C, cy: C, r: RINGS[k], fill: 'none', stroke: 'currentColor', 'stroke-opacity': '.28', 'stroke-dasharray': '3 4' }));
    svg.append(el('text', { x: C, y: C - RINGS[k] + 12, 'text-anchor': 'middle', fill: 'currentColor', 'fill-opacity': '.55', 'font-size': 8, 'letter-spacing': 1.5 }, label));
  });
  passes.forEach((p, i) => {
    const d = daysTo(p.event.starts_at);
    const r = RINGS[ringOf(d)];
    const a = ((i * 137 + 40) * Math.PI) / 180;
    const x = C + r * Math.cos(a);
    const y = C + r * Math.sin(a);
    const dim = p.status !== 'active' || (d !== null && d < 0);
    const g = el('g', { tabindex: '0', role: 'button', 'aria-label': `${p.event.name}, ${p.tier}`, style: 'cursor:pointer;outline-offset:2px' });
    g.append(el('circle', { cx: x, cy: y, r: i === selected ? 11 : 8, fill: dim ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': dim ? '3 3' : '' }));
    g.append(el('text', { x, y: y + 24, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 10 }, short(p.event.name)));
    g.addEventListener('click', () => onSelect(i));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } });
    svg.append(g);
  });
  svg.append(el('circle', { cx: C, cy: C, r: 22, fill: 'currentColor' }));
  svg.append(el('text', { x: C, y: C + 3, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 9, 'font-weight': 700, 'letter-spacing': 1 }, 'YOU'));
  return svg;
}

// The pass to feature: the soonest event that has not passed, else the first pass.
export function nextIndex(passes) {
  let best = -1;
  let bd = Infinity;
  passes.forEach((p, i) => {
    if (p.status !== 'active') return;
    const d = daysTo(p.event.starts_at);
    if (d !== null && d >= 0 && d < bd) { bd = d; best = i; }
  });
  if (best >= 0) return best;
  const open = passes.findIndex((p) => p.status === 'active');
  return open >= 0 ? open : 0;
}
