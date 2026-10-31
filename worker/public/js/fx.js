// Shared moving background for every page. Decoration only: pages read fine without it, and
// prefers-reduced-motion keeps it still. No network, no third-party code.
(function () {
  'use strict';
  if (window.__tapinFx) return;
  window.__tapinFx = true;
  var body = document.body;
  if (!body || !body.classList.contains('fx')) return;
  if (document.documentElement.classList.contains('is-native')) return;   // the phone app skips the moving background
  var calm = body.getAttribute('data-fx') === 'calm';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  // --- layers (inserted here so each page only needs the class, the stylesheet and this script) ---
  function layer(tag, cls, html) { var e = document.createElement(tag); e.className = 'fx-layer ' + cls; e.setAttribute('aria-hidden', 'true'); if (html) e.innerHTML = html; return e; }
  var cv = document.createElement('canvas');
  cv.id = 'fx-field'; cv.className = 'fx-layer'; cv.setAttribute('aria-hidden', 'true');
  var aurora = layer('div', 'fx-aurora', '<i></i><i></i><i></i><i></i>');
  body.insertBefore(aurora, body.firstChild);
  body.insertBefore(cv, body.firstChild);

  var col = { sig: '#B5A0CC', ok: '#7FE0B4' };
  function readColours() {
    var cs = getComputedStyle(document.documentElement);
    col.sig = cs.getPropertyValue('--signal').trim() || col.sig;
    col.ok = cs.getPropertyValue('--ok').trim() || col.ok;
  }
  readColours();
  if (window.MutationObserver) new MutationObserver(readColours).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  var visible = true;
  document.addEventListener('visibilitychange', function () { visible = !document.hidden; });

  var ctx = cv.getContext ? cv.getContext('2d') : null;
  if (!ctx) return;
  var W = 0, H = 0, dpr = 1, nodes = [], packets = [], rings = [];
  var ptr = { x: 0, y: 0, sx: 0, sy: 0, on: false };
  var scrollY = 0, t = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = clamp(Math.round((W * H) / (calm ? 30000 : 15000)), calm ? 14 : 24, calm ? 40 : 84);
    nodes = [];
    for (var i = 0; i < n; i++) {
      var z = .35 + Math.random() * .65; // depth: nearer points are bigger, faster and shift more on scroll
      nodes.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .45 * z, vy: (Math.random() - .5) * .45 * z, z: z, r: .8 + z * 1.8, ph: Math.random() * 6.28, px: 0, py: 0 });
    }
  }

  function frame() {
    t += .016;
    ctx.clearRect(0, 0, W, H);
    var i, j, a, b, dx, dy, d;
    // smooth the pointer so the glow and aurora glide instead of jumping
    ptr.sx += (ptr.x - ptr.sx) * .08; ptr.sy += (ptr.y - ptr.sy) * .08;
    aurora.style.setProperty('--ax', ((ptr.sx / W - .5) * -34).toFixed(1) + 'px');
    aurora.style.setProperty('--ay', ((ptr.sy / H - .5) * -26 - scrollY * .02).toFixed(1) + 'px');

    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      if (!reduce) {
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = W + 20; else if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20; else if (a.y > H + 20) a.y = -20;
        if (ptr.on) { dx = ptr.x - a.x; dy = ptr.y - (a.y); d = Math.sqrt(dx * dx + dy * dy); if (d < 190 && d > 1) { a.x += dx / d * .6; a.y += dy / d * .6; } }
      }
      a.px = a.x;
      a.py = (((a.y - scrollY * .22 * a.z) % H) + H) % H; // scroll parallax
    }
    ctx.lineWidth = 1; ctx.strokeStyle = col.sig;
    var links = [];
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j]; dx = a.px - b.px; dy = a.py - b.py;
        if (dx > 135 || dx < -135 || dy > 135 || dy < -135) continue;
        d = dx * dx + dy * dy;
        if (d < 18225) { ctx.globalAlpha = (1 - Math.sqrt(d) / 135) * .34; ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke(); if (links.length < 60) links.push([a, b]); }
      }
      if (ptr.on) {
        dx = ptr.x - a.px; dy = ptr.y - a.py; d = Math.sqrt(dx * dx + dy * dy);
        if (d < 190) { ctx.globalAlpha = (1 - d / 190) * .6; ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(ptr.x, ptr.y); ctx.stroke(); }
      }
    }
    // data packets travelling along the links
    if (!reduce && links.length && packets.length < (calm ? 3 : 8) && Math.random() < .04) { var l = links[(Math.random() * links.length) | 0]; packets.push({ a: l[0], b: l[1], p: 0, s: .012 + Math.random() * .014 }); }
    ctx.fillStyle = col.ok;
    for (i = packets.length - 1; i >= 0; i--) {
      var k = packets[i]; k.p += k.s;
      if (k.p >= 1) { packets.splice(i, 1); continue; }
      var x = k.a.px + (k.b.px - k.a.px) * k.p, yy = k.a.py + (k.b.py - k.a.py) * k.p;
      for (j = 0; j < 4; j++) { ctx.globalAlpha = (.7 - j * .17) * Math.sin(k.p * Math.PI); ctx.beginPath(); ctx.arc(x - (k.b.px - k.a.px) * .02 * j, yy - (k.b.py - k.a.py) * .02 * j, 2.4 - j * .4, 0, 6.2832); ctx.fill(); }
    }
    // pulsing points
    ctx.fillStyle = col.sig;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i]; var pu = .5 + .5 * Math.sin(t * 2 + a.ph);
      ctx.globalAlpha = .45 + .4 * pu; ctx.beginPath(); ctx.arc(a.px, a.py, a.r * (1 + .3 * pu), 0, 6.2832); ctx.fill();
    }
    // tap rings
    ctx.strokeStyle = col.ok;
    for (i = rings.length - 1; i >= 0; i--) {
      var r = rings[i]; r.r += 3; r.a -= .012;
      if (r.a <= 0) { rings.splice(i, 1); continue; }
      ctx.globalAlpha = r.a; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  size();
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { size(); if (reduce) frame(); }, 150); });
  window.addEventListener('scroll', function () { scrollY = window.pageYOffset || 0; }, { passive: true });
  window.addEventListener('pointermove', function (e) { ptr.x = e.clientX; ptr.y = e.clientY; if (!ptr.on) { ptr.sx = ptr.x; ptr.sy = ptr.y; } ptr.on = true; }, { passive: true });
  document.addEventListener('pointerleave', function () { ptr.on = false; });

  // spotlight on cards follows the cursor
  document.addEventListener('pointermove', function (e) {
    var s = e.target.closest ? e.target.closest('.card,.glass,.pass') : null;
    if (!s) return;
    var r = s.getBoundingClientRect();
    s.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    s.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  if (reduce) { frame(); return; }
  function tap(x, y, strong) {
    rings.push({ x: x, y: y, r: 4, a: strong ? .7 : .35 });
    nodes.forEach(function (n) { var dx = n.x - x, dy = n.py - y, d = Math.sqrt(dx * dx + dy * dy); if (d < 220 && d > 1) { n.vx = clamp(n.vx + dx / d * 1.6, -2, 2); n.vy = clamp(n.vy + dy / d * 1.6, -2, 2); } });
  }
  window.addEventListener('pointerdown', function (e) {
    tap(e.clientX, e.clientY, true);
    if (calm) return; // tools stay quiet: no big ripple over buttons people are pressing
    var el = document.createElement('div');
    el.className = 'fx-ripple'; el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px';
    el.addEventListener('animationend', function () { el.remove(); });
    body.appendChild(el);
  }, { passive: true });
  // the field settles back to a gentle drift, and taps itself now and then so it is alive without a mouse
  setInterval(function () { nodes.forEach(function (n) { n.vx *= .93; n.vy *= .93; if (Math.abs(n.vx) < .1 * n.z) n.vx += (Math.random() - .5) * .12; if (Math.abs(n.vy) < .1 * n.z) n.vy += (Math.random() - .5) * .12; }); }, 400);
  (function auto() { if (visible) tap(Math.random() * W, Math.random() * H, false); setTimeout(auto, 3800 + Math.random() * 3500); })();
  (function loop() { if (visible) frame(); requestAnimationFrame(loop); })();
})();
