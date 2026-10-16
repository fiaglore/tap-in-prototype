// Home page motion. Purely decorative: the page reads fine with this script off, and
// prefers-reduced-motion keeps everything still. No network, no third-party code.
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var rand = function (n) { return Math.floor(Math.random() * n); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  // ---- theme colours for the canvas ------------------------------------------------------------
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

  // ---- 1. Particle field: drifting nodes, links, pointer pull, tap ripples ---------------------
  var cv = $('#field');
  var ctx = cv && cv.getContext ? cv.getContext('2d') : null;
  var W = 0, H = 0, dpr = 1, nodes = [], rings = [], ptr = { x: -999, y: -999, on: false };
  function size() {
    if (!ctx) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = clamp(Math.round((W * H) / 17000), 22, 78);
    nodes = [];
    for (var i = 0; i < n; i++) nodes.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: 1 + Math.random() * 1.6 });
  }
  function frame() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    var i, j, a, b, d, dx, dy;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      if (!reduce) {
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = W + 20; else if (a.x > W + 20) a.x = -20;
        if (a.y < -20) a.y = H + 20; else if (a.y > H + 20) a.y = -20;
        if (ptr.on) { dx = ptr.x - a.x; dy = ptr.y - a.y; d = Math.sqrt(dx * dx + dy * dy); if (d < 190 && d > 1) { a.x += dx / d * .55; a.y += dy / d * .55; } }
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = col.sig;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j]; dx = a.x - b.x; dy = a.y - b.y;
        if (dx > 130 || dx < -130 || dy > 130 || dy < -130) continue;
        d = dx * dx + dy * dy;
        if (d < 16900) { ctx.globalAlpha = (1 - Math.sqrt(d) / 130) * .32; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      if (ptr.on) {
        dx = ptr.x - a.x; dy = ptr.y - a.y; d = Math.sqrt(dx * dx + dy * dy);
        if (d < 190) { ctx.globalAlpha = (1 - d / 190) * .6; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ptr.x, ptr.y); ctx.stroke(); }
      }
    }
    ctx.fillStyle = col.sig;
    for (i = 0; i < nodes.length; i++) { a = nodes[i]; ctx.globalAlpha = .75; ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill(); }
    // "tap" rings radiate from where you click or touch
    ctx.strokeStyle = col.ok;
    for (i = rings.length - 1; i >= 0; i--) {
      var r = rings[i]; r.r += 3.2; r.a -= .012;
      if (r.a <= 0) { rings.splice(i, 1); continue; }
      ctx.globalAlpha = r.a; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.2832); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function loop() { if (visible) frame(); requestAnimationFrame(loop); }
  if (ctx) {
    size();
    var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { size(); if (reduce) frame(); }, 150); });
    if (reduce) frame(); else requestAnimationFrame(loop);
  }
  window.addEventListener('pointermove', function (e) { ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true; }, { passive: true });
  document.addEventListener('pointerleave', function () { ptr.on = false; });
  window.addEventListener('pointerdown', function (e) {
    if (reduce) return;
    rings.push({ x: e.clientX, y: e.clientY, r: 4, a: .7 });
    var el = document.createElement('div');
    el.className = 'ripple'; el.style.left = e.clientX + 'px'; el.style.top = e.clientY + 'px';
    el.addEventListener('animationend', function () { el.remove(); });
    document.body.appendChild(el);
    nodes.forEach(function (n) { var dx = n.x - e.clientX, dy = n.y - e.clientY, d = Math.sqrt(dx * dx + dy * dy); if (d < 220 && d > 1) { n.vx += dx / d * 1.6; n.vy += dy / d * 1.6; n.vx = clamp(n.vx, -2, 2); n.vy = clamp(n.vy, -2, 2); } });
  }, { passive: true });
  // nodes slowly settle back to a gentle drift after a tap
  if (!reduce) setInterval(function () { nodes.forEach(function (n) { n.vx *= .93; n.vy *= .93; if (Math.abs(n.vx) < .08) n.vx += (Math.random() - .5) * .1; if (Math.abs(n.vy) < .08) n.vy += (Math.random() - .5) * .1; }); }, 400);

  // ---- 2. Tilting phone, spotlight cards ---------------------------------------------------------
  var stage = $('#stage'), phone = $('#phone');
  if (stage && phone && fine && !reduce) {
    stage.parentNode.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      var x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
      phone.style.setProperty('--ry', ((x - .5) * 26).toFixed(1) + 'deg');
      phone.style.setProperty('--rx', ((.5 - y) * 20).toFixed(1) + 'deg');
      phone.style.setProperty('--gx', (x * 100).toFixed(0) + '%');
      phone.style.setProperty('--gy', (y * 100).toFixed(0) + '%');
    });
    stage.parentNode.addEventListener('pointerleave', function () { phone.style.setProperty('--rx', '0deg'); phone.style.setProperty('--ry', '0deg'); });
  }
  document.addEventListener('pointermove', function (e) {
    var s = e.target.closest ? e.target.closest('.spot') : null;
    if (!s) return;
    var r = s.getBoundingClientRect();
    s.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    s.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  // ---- 3. The live QR on the phone ---------------------------------------------------------------
  var qr = $('#qr'), codeEl = $('#code'), statusEl = $('#status');
  if (qr && qr.getContext) {
    var q = qr.getContext('2d'), N = 24, cell = qr.width / N, grid = [];
    var inFinder = function (x, y) { return (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9); };
    for (var gy = 0; gy < N; gy++) { grid[gy] = []; for (var gx = 0; gx < N; gx++) grid[gy][gx] = Math.random() < .5; }
    var drawQr = function () {
      q.fillStyle = '#fff'; q.fillRect(0, 0, qr.width, qr.height);
      q.fillStyle = '#2B1B2D';
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) if (!inFinder(x, y) && grid[y][x]) q.fillRect(x * cell, y * cell, cell + .5, cell + .5);
      [[0, 0], [N - 7, 0], [0, N - 7]].forEach(function (p) {
        q.fillRect(p[0] * cell, p[1] * cell, 7 * cell, 7 * cell);
        q.fillStyle = '#fff'; q.fillRect((p[0] + 1) * cell, (p[1] + 1) * cell, 5 * cell, 5 * cell);
        q.fillStyle = '#2B1B2D'; q.fillRect((p[0] + 2) * cell, (p[1] + 2) * cell, 3 * cell, 3 * cell);
      });
    };
    var newCode = function () {
      var g = function (n) { var s = ''; for (var i = 0; i < n; i++) s += B32[rand(32)]; return s; };
      if (codeEl) codeEl.textContent = 'TQ-' + g(4) + '-' + g(4) + '-' + g(4);
    };
    drawQr(); newCode();
    if (reduce) { if (statusEl) { statusEl.textContent = 'Welcome in'; statusEl.className = 'p-status ok'; } }
    else {
      // The code reshuffles in a sweep, like the real 30-second live QR.
      setInterval(function () {
        if (!visible) return;
        var row = 0;
        var t = setInterval(function () {
          for (var x = 0; x < N; x++) grid[row][x] = Math.random() < .5;
          drawQr(); row++;
          if (row >= N) { clearInterval(t); newCode(); }
        }, 22);
      }, 3600);
      var names = ['Ada O.', 'Tunde B.', 'Ngozi E.', 'Femi A.', 'Zainab M.', 'Chidi N.'];
      var cycle = function () {
        if (!statusEl) return;
        statusEl.className = 'p-status'; statusEl.textContent = 'Scanning…';
        setTimeout(function () { statusEl.className = 'p-status ok'; statusEl.textContent = '✓ Welcome in, ' + names[rand(names.length)]; }, 2300);
      };
      cycle(); setInterval(function () { if (visible) cycle(); }, 4600);
    }
  }

  // ---- 4. Headline word that decodes into the next one -------------------------------------------
  var swap = $('#swap');
  if (swap && !reduce) {
    var words = ['pass', 'key', 'wallet', 'ticket', 'door'], wi = 0, busy = false;
    var decode = function (to) {
      if (busy) return; busy = true;
      var from = swap.textContent, len = Math.max(from.length, to.length), f = 0, total = 16;
      var t = setInterval(function () {
        var out = '';
        for (var i = 0; i < len; i++) {
          var settle = Math.floor((i + 1) / len * total * .8) ;
          if (f >= settle || i >= to.length && f > total * .7) out += to[i] || '';
          else out += B32[rand(32)].toLowerCase();
        }
        swap.textContent = out; f++;
        if (f > total) { clearInterval(t); swap.textContent = to; busy = false; }
      }, 38);
    };
    setInterval(function () { if (visible) { wi = (wi + 1) % words.length; decode(words[wi]); } }, 3200);
  }

  // ---- 5. Scroll reveal, counters, how-it-works progress -----------------------------------------
  function countUp(el) {
    var end = Number(el.getAttribute('data-count')) || 0;
    if (reduce || end === 0) { el.textContent = end.toLocaleString('en-NG'); return; }
    var t0 = performance.now(), dur = 1300;
    (function step(t) {
      var p = clamp((t - t0) / dur, 0, 1), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(end * e).toLocaleString('en-NG');
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  var counters = $$('[data-count]');
  if (!reduce) counters.forEach(function (el) { el.textContent = '0'; });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        $$('[data-count]', e.target).forEach(countUp);
        io.unobserve(e.target);
      });
    }, { threshold: .15 });
    $$('.rv').forEach(function (el) { io.observe(el); });
    var co = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { countUp(e.target); co.unobserve(e.target); } });
    }, { threshold: .6 });
    counters.forEach(function (el) { if (!el.closest('.rv')) co.observe(el); });
  } else {
    $$('.rv').forEach(function (el) { el.classList.add('in'); });
    counters.forEach(countUp);
  }
  var steps = $('.steps');
  if (steps) {
    var onScroll = function () {
      var r = steps.getBoundingClientRect(), vh = window.innerHeight;
      var p = clamp((vh * .62 - r.top) / r.height, 0, 1);
      steps.style.setProperty('--p', (p * 100).toFixed(1) + '%');
      $$('li', steps).forEach(function (li) { li.classList.toggle('on', li.getBoundingClientRect().top < vh * .68); });
    };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  // ---- 6. Simulated gate feed --------------------------------------------------------------------
  var feed = $('#feed'), cIn = $('#cIn'), cNo = $('#cNo');
  if (feed) {
    var people = ['Ada O.', 'Tunde B.', 'Ngozi E.', 'Femi A.', 'Zainab M.', 'Chidi N.', 'Bola A.', 'Kemi S.', 'Emeka U.', 'Sade L.'];
    var groups = ['VIP · Main grounds', 'General · Main grounds', 'Staff · Backstage', 'Crew · Loading bay'];
    var refusals = ['Screenshot, not the live code', 'Wrong area for this pass', 'Pass was cancelled', 'Old code, please reopen the pass'];
    var nIn = 0, nNo = 0;
    var add = function (animate) {
      var bad = Math.random() < .17, who = people[rand(people.length)];
      var li = document.createElement('li');
      if (bad) { li.className = 'no'; nNo++; } else nIn++;
      var left = document.createElement('div'), name = document.createElement('strong'), sub = document.createElement('small');
      name.textContent = who; sub.textContent = bad ? refusals[rand(refusals.length)] : groups[rand(groups.length)];
      left.appendChild(name); left.appendChild(sub);
      var chip = document.createElement('span');
      chip.className = 'chip ' + (bad ? 'bad' : 'ok'); chip.textContent = bad ? 'Turned away' : 'Entered';
      li.appendChild(left); li.appendChild(chip);
      if (!animate) li.style.animation = 'none';
      feed.insertBefore(li, feed.firstChild);
      while (feed.children.length > 5) feed.removeChild(feed.lastChild);
      if (cIn) cIn.textContent = String(nIn); if (cNo) cNo.textContent = String(nNo);
    };
    for (var k = 0; k < 4; k++) add(false);
    if (!reduce) {
      var run = false, timer = null;
      var tick = function () { if (run && visible) add(true); timer = setTimeout(tick, 1400 + rand(1400)); };
      if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { run = es[0].isIntersecting; }).observe(feed);
      else run = true;
      tick();
    }
  }
})();
