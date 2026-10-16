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

  var visible = true;
  document.addEventListener('visibilitychange', function () { visible = !document.hidden; });

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

  // ======================= More immersive layer =======================
  var vh = function () { return window.innerHeight; };
  var scrollNow = function () { return window.pageYOffset || 0; };
  var colr = { sig: '#B5A0CC', ok: '#7FE0B4', a2: '#8fb4ff' };
  function readCols() {
    var cs = getComputedStyle(document.body);
    colr.sig = cs.getPropertyValue('--signal').trim() || colr.sig;
    colr.ok = cs.getPropertyValue('--ok').trim() || colr.ok;
    colr.a2 = cs.getPropertyValue('--accent2').trim() || colr.a2;
  }
  readCols();
  if (window.MutationObserver) new MutationObserver(readCols).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });

  // ---- 7. Flight through a tunnel of glowing doorways; scrolling is acceleration ------------------
  var tun = document.createElement('canvas');
  tun.id = 'tunnel'; tun.setAttribute('aria-hidden', 'true');
  var gridLayer = $('.fx-grid');
  if (gridLayer && gridLayer.parentNode) gridLayer.parentNode.insertBefore(tun, gridLayer.nextSibling); else document.body.insertBefore(tun, document.body.firstChild);
  var tx = tun.getContext('2d'), TW = 0, TH = 0, tdpr = 1, rings = [], lite = false, slow = 0;
  var vp = { x: 0, y: 0, tx: 0, ty: 0 }, last = performance.now(), svel = 0, lastSy = scrollNow();
  var RING_N = 26;
  function tsize() {
    tdpr = Math.min(window.devicePixelRatio || 1, 2);
    TW = window.innerWidth; TH = window.innerHeight;
    tun.width = TW * tdpr; tun.height = TH * tdpr; tx.setTransform(tdpr, 0, 0, tdpr, 0, 0);
    vp.tx = vp.x = TW / 2; vp.ty = vp.y = TH * .46;
    rings = [];
    for (var i = 0; i < RING_N; i++) rings.push({ z: i / RING_N, hot: i % 5 === 0 });
  }
  function rr(x, y, w, h, r) {
    tx.beginPath(); tx.moveTo(x + r, y); tx.arcTo(x + w, y, x + w, y + h, r); tx.arcTo(x + w, y + h, x, y + h, r); tx.arcTo(x, y + h, x, y, r); tx.arcTo(x, y, x + w, y, r); tx.closePath();
  }
  function tframe(now) {
    var dt = Math.min(64, now - last); last = now;
    // adaptive quality: if frames are slow for a while, thin the tunnel out
    if (dt > 30) slow++; else if (slow > 0) slow--;
    if (slow > 50 && !lite) { lite = true; rings = rings.filter(function (r, i) { return i % 2 === 0; }); }
    var sy = scrollNow(), dv = (sy - lastSy) / Math.max(1, dt); lastSy = sy;
    svel += (clamp(Math.abs(dv), 0, 6) - svel) * .12;                    // smoothed scroll speed
    var top = clamp(1 - sy / (vh() * 1.1), 0, 1);                        // strongest in the hero
    var power = .22 + top * .78;
    tx.clearRect(0, 0, TW, TH);
    vp.x += (vp.tx - vp.x) * .06; vp.y += (vp.ty - vp.y) * .06;
    var cx = vp.x, cy = vp.y - sy * .05;
    var speed = (.0009 + svel * .0042) * dt;                              // drift plus scroll boost
    var maxS = Math.max(TW, TH) * 1.7, i, r;
    // speed lines when scrolling fast
    if (svel > .9) {
      tx.strokeStyle = colr.sig; tx.lineWidth = 1;
      for (i = 0; i < 18; i++) { var an = (i / 18) * 6.2832 + .3, len = clamp(svel * 70, 0, 340); tx.globalAlpha = clamp((svel - .9) * .12, 0, .22) * power; tx.beginPath(); tx.moveTo(cx + Math.cos(an) * 90, cy + Math.sin(an) * 90); tx.lineTo(cx + Math.cos(an) * (90 + len), cy + Math.sin(an) * (90 + len)); tx.stroke(); }
    }
    for (i = 0; i < rings.length; i++) {
      r = rings[i];
      r.z -= speed * (.4 + r.z);                                         // nearer rings move faster: depth
      if (r.z < .012) { r.z += 1; r.hot = Math.random() < .2; }
      var k = Math.pow(1 - r.z, 2.4);                                    // 0 far, 1 at the camera
      var w = 24 + k * maxS * .62, h = w * 1.55;
      var x = cx - w / 2 + (TW / 2 - cx) * k * .5, y = cy - h / 2 + (TH / 2 - cy) * k * .5;
      // fade a doorway out before it grows taller than the screen, so you always see a whole doorway and never bare vertical bars
      var fit = clamp((TH * .92 - h) / (TH * .5), 0, 1);
      var a = Math.sin(Math.PI * clamp(k * 1.05, 0, 1)) * .5 * power * fit;
      if (a < .01) continue;
      tx.strokeStyle = r.hot ? colr.ok : colr.sig;
      tx.globalAlpha = a * .3; tx.lineWidth = 5 + k * 5; rr(x, y, w, h, 8 + k * 26); tx.stroke();   // soft glow
      tx.globalAlpha = a; tx.lineWidth = 1 + k * 1.6; rr(x, y, w, h, 8 + k * 26); tx.stroke();        // crisp edge
    }
    tx.globalAlpha = 1;
  }
  if (!reduce) {
    tsize();
    window.addEventListener('resize', function () { setTimeout(tsize, 120); });
    window.addEventListener('pointermove', function (e) { vp.tx = e.clientX * .5 + TW * .25; vp.ty = e.clientY * .4 + TH * .28; }, { passive: true });
    (function tloop(now) { if (visible) tframe(now); else last = now; requestAnimationFrame(tloop); })(performance.now());
  }

  // ---- 8. Depth parallax: headline and glass fragments move at different speeds ---------------------
  var heroCopy = $('.hero-copy'), frags = $$('.frag'), pp = { x: 0, y: 0, sx: 0, sy: 0 };
  if (!reduce && fine) {
    window.addEventListener('pointermove', function (e) { pp.x = e.clientX / window.innerWidth - .5; pp.y = e.clientY / window.innerHeight - .5; }, { passive: true });
    (function par() {
      pp.sx += (pp.x - pp.sx) * .07; pp.sy += (pp.y - pp.sy) * .07;
      if (heroCopy) heroCopy.style.transform = 'translate3d(' + (pp.sx * -10).toFixed(2) + 'px,' + (pp.sy * -8).toFixed(2) + 'px,0)';
      frags.forEach(function (f) { var d = Number(f.getAttribute('data-depth')) || 30; f.style.setProperty('--tx', (pp.sx * d * -1.4).toFixed(1) + 'px'); f.style.setProperty('--ty', (pp.sy * d * -1.1).toFixed(1) + 'px'); });
      requestAnimationFrame(par);
    })();
  }
  var fragT = $('#fragTimer');
  if (fragT && !reduce) setInterval(function () { var s = 30 - (Math.floor(Date.now() / 1000) % 30); fragT.textContent = '0:' + String(s).padStart(2, '0'); }, 500);

  // ---- 9. Scroll progress, huge sliding type, cursor light, tilting cards -------------------------
  var prog = $('#progress'), big = $('#bigtext span'), cl = $('#cursorLight');
  function onScrollFx() {
    var h = document.documentElement.scrollHeight - vh(), sy = scrollNow();
    if (prog) prog.style.setProperty('--sp', h > 0 ? clamp(sy / h, 0, 1).toFixed(4) : 0);
    if (big && !reduce) { var r = big.parentNode.getBoundingClientRect(); big.style.setProperty('--bx', ((r.top - vh() * .5) * -.55).toFixed(1) + 'px'); }
  }
  window.addEventListener('scroll', onScrollFx, { passive: true }); onScrollFx();
  if (cl && fine && !reduce) {
    var cp = { x: window.innerWidth / 2, y: window.innerHeight / 2, sx: 0, sy: 0 };
    window.addEventListener('pointermove', function (e) { cp.x = e.clientX; cp.y = e.clientY; cl.classList.add('on'); }, { passive: true });
    document.addEventListener('pointerleave', function () { cl.classList.remove('on'); });
    (function cloop() { cp.sx += (cp.x - cp.sx) * .12; cp.sy += (cp.y - cp.sy) * .12; cl.style.transform = 'translate3d(' + cp.sx.toFixed(1) + 'px,' + cp.sy.toFixed(1) + 'px,0)'; requestAnimationFrame(cloop); })();
  }
  if (fine && !reduce) {
    $$('.prod').forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
        el.style.setProperty('--ry', (x * 12).toFixed(1) + 'deg'); el.style.setProperty('--rx', (-y * 10).toFixed(1) + 'deg');
      });
      el.addEventListener('pointerleave', function () { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
    });
  }

  // ---- 10. Pinned story: scroll moves one phone through an office, a concert and a till ------------
  var story = $('#story');
  if (story) {
    var sTrack = $('.story-track', story), sPhone = $('#storyPhone'), sSteps = $$('.story-steps li', story), sScreens = $$('.screen', story), sBar = $('.story-prog', story), cur = -1;
    // a little pseudo-QR on the concert screen, reshuffled while that screen is up
    var sq = $('#storyQr'), sqc = sq && sq.getContext ? sq.getContext('2d') : null, SN = 24, sg = [];
    var sFinder = function (x, y) { return (x < 8 && y < 8) || (x > SN - 9 && y < 8) || (x < 8 && y > SN - 9); };
    var sDraw = function () {
      if (!sqc) return; var c = sq.width / SN; sqc.fillStyle = '#fff'; sqc.fillRect(0, 0, sq.width, sq.height); sqc.fillStyle = '#2B1B2D';
      for (var y = 0; y < SN; y++) for (var x = 0; x < SN; x++) if (!sFinder(x, y) && sg[y] && sg[y][x]) sqc.fillRect(x * c, y * c, c + .5, c + .5);
      [[0, 0], [SN - 7, 0], [0, SN - 7]].forEach(function (p) { sqc.fillRect(p[0] * c, p[1] * c, 7 * c, 7 * c); sqc.fillStyle = '#fff'; sqc.fillRect((p[0] + 1) * c, (p[1] + 1) * c, 5 * c, 5 * c); sqc.fillStyle = '#2B1B2D'; sqc.fillRect((p[0] + 2) * c, (p[1] + 2) * c, 3 * c, 3 * c); });
    };
    var sShuffle = function () { for (var y = 0; y < SN; y++) { sg[y] = sg[y] || []; for (var x = 0; x < SN; x++) sg[y][x] = Math.random() < .5; } sDraw(); var ce = $('#storyCode'); if (ce) { var s = 'TQ-'; for (var i = 0; i < 8; i++) { s += B32[rand(32)]; if (i === 3) s += '-'; } ce.textContent = s; } };
    sShuffle();
    if (!reduce) setInterval(function () { if (visible && cur === 1) sShuffle(); }, 1800);
    var setStep = function (i) {
      if (i === cur) return; cur = i;
      sSteps.forEach(function (li, k) { li.classList.toggle('on', k === i); });
      sScreens.forEach(function (sc, k) { sc.classList.toggle('on', k === i); });
      document.documentElement.style.setProperty('--hue', (i * 38) + 'deg');   // the whole backdrop shifts colour per scene
      document.body.style.setProperty('--hue', (i * 38) + 'deg');
    };
    var onStory = function () {
      var r = sTrack.getBoundingClientRect(), span = r.height - vh();
      var p = span > 0 ? clamp(-r.top / span, 0, 1) : 0;
      setStep(Math.min(2, Math.floor(p * 3 - .0001)));
      if (sBar) sBar.style.setProperty('--p', p.toFixed(3));
      if (sPhone && !reduce) {
        sPhone.style.setProperty('--sry', (-14 + p * 28).toFixed(1) + 'deg');
        sPhone.style.setProperty('--srx', (6 - p * 10).toFixed(1) + 'deg');
        sPhone.style.setProperty('--ss', (.94 + Math.sin(p * Math.PI) * .1).toFixed(3));
      }
    };
    if (reduce) { sScreens.forEach(function (sc, k) { sc.classList.toggle('on', k === 0); }); }
    else { window.addEventListener('scroll', onStory, { passive: true }); window.addEventListener('resize', onStory); onStory(); }
  }
})();
