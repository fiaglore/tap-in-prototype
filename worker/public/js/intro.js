// "Tap to enter": a short opening for the home page. Skippable, once per visit, and never shown with
// reduced motion (theme.js decides that before first paint by setting html.intro-lock).
(function () {
  'use strict';
  var root = document.documentElement, intro = document.getElementById('intro');
  // A fine film grain, drawn once into a tiny canvas and tiled.
  (function grain() {
    if (root.classList.contains('is-native')) return;   // the phone app skips the film grain
    try {
      var c = document.createElement('canvas'); c.width = c.height = 160;
      var g = c.getContext('2d'), im = g.createImageData(160, 160);
      for (var i = 0; i < im.data.length; i += 4) { var v = Math.random() * 255 | 0; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
      g.putImageData(im, 0, 0);
      var el = document.createElement('div'); el.className = 'grain'; el.setAttribute('aria-hidden', 'true'); el.style.backgroundImage = 'url(' + c.toDataURL() + ')';
      document.body.appendChild(el);
    } catch (e) {}
  })();

  if (!intro) return;
  if (!root.classList.contains('intro-lock')) { intro.remove(); return; }
  window.__tapinIntro = true;

  var body = document.body, main = document.querySelector('main'), enter = document.getElementById('introEnter'), skip = document.getElementById('introSkip');
  var done = false;
  if (main && 'inert' in main) main.inert = true;
  var prevFocus = document.activeElement;
  if (enter) enter.focus({ preventScroll: true });
  try { sessionStorage.setItem('tapin-intro', String(Date.now())); } catch (e) {}

  function finish() {
    if (done) return; done = true;
    if (window.__tapinNext) { location.replace(window.__tapinNext); return; }   // the phone app's front door: on to the events home
    if (main) main.inert = false;
    root.classList.remove('intro-lock');
    intro.remove();
    window.scrollTo(0, 0);
  }
  function open() {
    if (done || intro.classList.contains('go')) return;
    intro.classList.add('go');                 // centre dissolves, door starts to split
    setTimeout(function () { root.classList.remove('intro-lock'); body.classList.add('entered'); if (main) main.inert = false; }, 700); // the page pushes in as the light spills
    setTimeout(finish, window.__tapinNext ? 1100 : 2200);   // in the app the home page is already waiting, so go on sooner
  }
  function quick() {                            // Skip / Escape: no ceremony
    if (done) return;
    intro.classList.add('out');
    root.classList.remove('intro-lock'); if (main) main.inert = false;
    setTimeout(finish, 520);
  }
  if (enter) enter.addEventListener('click', open);
  if (skip) skip.addEventListener('click', quick);
  document.addEventListener('keydown', function (e) { if (!done && e.key === 'Escape') quick(); });
  // keep keyboard focus inside the intro while it is up
  intro.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var f = [enter, skip].filter(Boolean), i = f.indexOf(document.activeElement);
    e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
  });
  window.addEventListener('pagehide', function () { if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) {} });
})();
