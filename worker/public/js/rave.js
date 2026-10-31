// Home page atmosphere: a quiet rave behind the content. Light beams sweep and pulse to the beat (CSS), and
// tiny sparks drift. Tapping anywhere throws a few sparks and, on phones, a short buzz;
// "Tap to enter" gets a bigger burst and the lights flare. Decoration only: reduced motion shows no sparks.
(function () {
  'use strict';
  var rave = document.getElementById('rave'), cv = document.getElementById('sparks');
  if (!rave || document.documentElement.classList.contains('is-native')) return;   // the phone app skips the sparks and beams
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rand = function (a, b) { return a + Math.random() * (b - a); };

  // ---- Sparks --------------------------------------------------------------------------------------------------------------
  var visible = true;
  document.addEventListener('visibilitychange', function () { visible = !document.hidden; });
  var ctx = cv && cv.getContext ? cv.getContext('2d') : null, parts = [], W = 0, H = 0, running = false;
  var light = function () { return document.documentElement.getAttribute('data-mode') === 'light'; };
  var HUES = [275, 300, 330, 200, 160, 45];
  function size() { if (!cv) return; W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
  size(); window.addEventListener('resize', size);
  function spawn(x, y, vx, vy, life, r) { parts.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, r: r, h: HUES[(Math.random() * HUES.length) | 0] }); }
  function ambient() { spawn(rand(0, W), H + 6, rand(-.12, .12), -rand(.25, .7), rand(260, 480), rand(.8, 2.1)); }
  function burst(x, y, n, power) {
    if (reduce || !ctx) return;
    for (var i = 0; i < n; i++) { var a = rand(0, 6.283), v = rand(.8, power); spawn(x, y, Math.cos(a) * v, Math.sin(a) * v - 1, rand(40, 90), rand(1.4, 3.2)); }
    start();
  }
  function frame() {
    running = false;
    if (!ctx || reduce) return;
    if (!visible) { start(); return; }
    ctx.clearRect(0, 0, W, H);
    var lt = light();
    ctx.globalCompositeOperation = lt ? 'source-over' : 'lighter';
    if (parts.length < 46 && Math.random() < .18) ambient();
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i]; p.x += p.vx; p.y += p.vy; p.vx *= .985; p.vy = p.vy * .985 - .004; p.life--;
      if (p.life <= 0 || p.y < -10) { parts.splice(i, 1); continue; }
      var a = Math.min(1, p.life / p.max * 1.6) * .8;
      ctx.beginPath(); ctx.fillStyle = 'hsla(' + p.h + ',' + (lt ? '70%,45%,' : '95%,68%,') + a.toFixed(2) + ')';
      ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    start();
  }
  function start() { if (running || reduce) return; running = true; requestAnimationFrame(frame); }
  if (!reduce) { for (var k = 0; k < 18; k++) { ambient(); parts[parts.length - 1].y = rand(0, H); } start(); }

  // ---- Touch: a few sparks and a short buzz wherever you tap ---------------------------------------------------------------
  var buzz = function (p) { try { if (!reduce && navigator.vibrate) navigator.vibrate(p); } catch (e) {} };
  document.addEventListener('pointerdown', function (e) { burst(e.clientX, e.clientY, 10, 3.2); buzz(8); }, { passive: true });

  // ---- "Tap to enter": the lights flare ---------------------------------------------------------------------
  function cheer() {
    rave.classList.add('cheer');
    setTimeout(function () { rave.classList.remove('cheer'); }, 2600);
  }
  var enter = document.getElementById('introEnter');
  if (enter) enter.addEventListener('click', function () {
    var r = enter.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + 42, 46, 6.5); buzz([18, 40, 26]); cheer();
  });
})();
