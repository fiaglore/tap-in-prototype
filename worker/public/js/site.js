document.getElementById('theme-slot').replaceWith(window.TapTheme.button());

// On phones the header links collapse into a Menu button so offices, vendors and organisers stay reachable.
(() => {
  const nav = document.querySelector('.topbar nav[aria-label="Main"]');
  const topbar = nav && nav.closest('.topbar');
  const links = nav ? [...nav.querySelectorAll('a.btn.ghost')] : [];
  if (!topbar || links.length === 0) return;
  const panel = document.createElement('div');
  panel.className = 'menu-panel'; panel.id = 'menu-panel'; panel.hidden = true;
  for (const a of links) { const c = a.cloneNode(true); c.className = 'btn ghost'; panel.append(c); }
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'menu-btn'; btn.textContent = 'Menu';
  btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'menu-panel');
  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); });
  document.addEventListener('click', (e) => { if (!panel.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  nav.prepend(btn);
  topbar.append(panel);
})();
