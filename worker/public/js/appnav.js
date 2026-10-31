// The phone app's bottom tabs: Events (the home page), Organiser, Passes, Account. They appear only inside the app, so the
// website looks exactly as it always did. Each tab is a page; moving between tabs replaces the page, so the Back button
// does not fill up with tab changes. Passes and Account are two views of /app/ and switch without reloading.
(function () {
  'use strict';
  var root = document.documentElement;
  if (!root.classList.contains('is-native')) return;
  var path = location.pathname;
  var area = /^\/(play|e)\/(index\.html)?$/.test(path) ? 'events'
    : /^\/organiser\/(index\.html)?$/.test(path) ? 'organiser'
    : /^\/app\/(index\.html)?$/.test(path) ? (/^#(me|custom|delete)$/.test(location.hash) ? 'account' : 'passes')
    : null;
  // Tap In's logo takes you to the events home, not the marketing site. Every page, including ones drawn later.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.getAttribute('href') === '/' && !e.defaultPrevented) { e.preventDefault(); location.replace('/play/'); }
  }, true);
  if (!area) return;                                            // the opening screen, scanner, sign-in and invites have no tabs

  var NS = 'http://www.w3.org/2000/svg';
  var TABS = [
    { id: 'events', label: 'Events', href: '/play/', d: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 13h3' },
    { id: 'organiser', label: 'Organiser', href: '/organiser/', d: 'M3 11l14-6v14L3 13zM7 14l1.2 5h3L10 14.5' },
    { id: 'passes', label: 'Passes', href: '/app/#passes', d: 'M4 7h16v10H4zM4 11h16' },
    { id: 'account', label: 'Account', href: '/app/#me', d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0' }
  ];
  var nav = document.createElement('nav'), row = document.createElement('div'), links = {};
  nav.className = 'apptabs'; nav.setAttribute('aria-label', 'Main'); nav.appendChild(row);
  TABS.forEach(function (t) {
    var a = document.createElement('a'), svg = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    a.href = t.href; a.setAttribute('data-tab', t.id);
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); p.setAttribute('d', t.d); svg.appendChild(p);
    a.appendChild(svg); a.appendChild(document.createTextNode(t.label));
    a.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      if (t.id === area && a.pathname === location.pathname) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }   // the tab you are on: back to the top
      if (a.pathname === location.pathname) { location.hash = a.hash; return; }                                           // Passes <-> Account: the page switches view itself
      location.replace(t.href);
    });
    links[t.id] = a; row.appendChild(a);
  });
  function setActive(id) { area = id; Object.keys(links).forEach(function (k) { if (k === id) links[k].setAttribute('aria-current', 'page'); else links[k].removeAttribute('aria-current'); }); }
  setActive(area);
  window.addEventListener('tapin:tab', function (e) { if (e.detail && links[e.detail.area]) setActive(e.detail.area); });

  // The on-screen keyboard needs the room: tuck the tabs away while it is open. The keyboard shows up as the page getting
  // clearly shorter at the same width (turning the phone changes the width, so that does not count).
  var tallest = window.innerHeight, width = window.innerWidth;
  function resized() {
    if (window.innerWidth !== width) { width = window.innerWidth; tallest = window.innerHeight; nav.classList.remove('kb'); return; }
    tallest = Math.max(tallest, window.innerHeight);
    nav.classList.toggle('kb', window.innerHeight < tallest * 0.8);
  }
  window.addEventListener('resize', resized);

  document.body.appendChild(nav);
  if (!document.getElementById('app')) document.body.classList.add('has-apptabs');   // /app/ already leaves room at the bottom
})();
