// The phone app's front door: the website's "Tap to enter" opening, then the events home. A repeat visit in the same
// session or ?intro=0 go straight through (theme.js decides that by not locking the page for the intro). Reduced motion does not
// skip it here: the screen is the app's front door, and Android's "remove animations" setting would otherwise hide it.
(function () {
  'use strict';
  var m = /[?&]next=(\/(?:play|app|organiser|gate)\/)(?:&|$)/.exec(location.search);
  var next = m ? m[1] : '/play/';
  window.__tapinNext = next;                                   // intro.js carries on here when the opening ends
  if (!document.documentElement.classList.contains('intro-lock')) { location.replace(next); return; }
  setTimeout(function () { if (!window.__tapinIntro) location.replace(next); }, 5200);   // never trap anyone if the opening cannot run

  // While the logo plays, quietly fetch the home page and the files it needs, so the hand-over is instant, not a blank wait.
  function warm() {
    try {
      fetch(next, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
        var seen = {}, re = /(?:href|src)="(\/[^"]+\.(?:css|js)(?:\?[^"]*)?)"/g, mm;
        while ((mm = re.exec(html))) {
          if (seen[mm[1]]) continue; seen[mm[1]] = 1;
          var l = document.createElement('link'); l.rel = 'prefetch'; l.href = mm[1]; document.head.appendChild(l);
        }
      }).catch(function () {});
    } catch (e) {}
  }
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 1500 }); else setTimeout(warm, 300);
})();
