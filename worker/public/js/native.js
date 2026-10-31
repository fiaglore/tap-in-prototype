// Tap In inside its phone app (the Capacitor shell in /mobile). In a browser this file does nothing.
// It only switches on what a web page cannot do alone: the status bar and splash, a light tap of feedback on buttons,
// the phone's share sheet, and opening links to tap-in.world (sign-in emails, invitations) inside the app.
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;
  var root = document.documentElement, P = C.Plugins || {};
  root.classList.add('is-native', 'is-' + (C.getPlatform ? C.getPlatform() : 'native'));
  var call = function (plugin, method, arg) { try { var p = P[plugin]; if (p && p[method]) return p[method](arg); } catch (e) {} };

  call('StatusBar', 'setStyle', { style: 'DARK' });                      // light icons on the plum bar
  call('StatusBar', 'setBackgroundColor', { color: '#2B1B2D' });
  window.addEventListener('load', function () { setTimeout(function () { call('SplashScreen', 'hide', { fadeOutDuration: 250 }); }, 50); });

  // for pages that want the phone's own share sheet or the app's version
  window.TapInNative = {
    share: function (o) {
      var S = P.Share;
      if (!S || !S.share) return Promise.resolve(false);
      return S.share({ title: o.title, text: o.text, url: o.url, dialogTitle: o.title }).then(function () { return true; }, function () { return false; });
    },
    version: function () {
      var A = P.App;
      return A && A.getInfo ? A.getInfo().then(function (i) { return i.version + (i.build ? ' (' + i.build + ')' : ''); }, function () { return ''; }) : Promise.resolve('');
    }
  };

  // a light tap of feedback when a main button is pressed
  document.addEventListener('pointerdown', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.btn.primary, .tab, .tapbtn') : null;
    if (b) call('Haptics', 'impact', { style: 'LIGHT' });
  }, { passive: true });

  // links to our own site that open the app (App Links on Android, Universal Links on iPhone) stay in the app
  var HOSTS = /^(www\.|business\.)?tap-in\.world$/;
  var app = P.App;
  if (app && app.addListener) {
    app.addListener('appUrlOpen', function (ev) {
      try {
        var u = new URL(ev.url);
        if (u.protocol === 'https:' && HOSTS.test(u.hostname)) location.href = u.pathname + u.search + u.hash;
      } catch (e) {}
    });
  }
})();
