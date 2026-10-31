// The phone app's front door: the website's "Tap to enter" opening, then the events home. A repeat visit in the same
// session, reduced motion, or ?intro=0 go straight through (theme.js decides that by not locking the page for the intro).
(function () {
  'use strict';
  var m = /[?&]next=(\/(?:play|app|organiser)\/)(?:&|$)/.exec(location.search);
  var next = m ? m[1] : '/play/';
  window.__tapinNext = next;                                   // intro.js carries on here when the opening ends
  if (!document.documentElement.classList.contains('intro-lock')) { location.replace(next); return; }
  setTimeout(function () { if (!window.__tapinIntro) location.replace(next); }, 5200);   // never trap anyone if the opening cannot run
})();
