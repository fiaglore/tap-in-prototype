// Classic script loaded in <head> so the right colours apply before first paint.
(function () {
  document.documentElement.classList.add('js'); // lets pages hide things for scroll reveals only when scripts run
  // The home page (and the phone app's /enter/ front door) opens with a short "tap to enter" intro, once per visit. It is skipped for reduced motion,
  // deep links (#...), ?intro=0, and a repeat visit in the same tab; ?intro=1 plays it again.
  try {
    var path = location.pathname, q = location.search;
    if ((path === '/' || path === '/index.html' || path === '/enter/') && !location.hash && !/[?&]intro=0/.test(q)) {
      var rm = path !== '/enter/' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;   // the app's front door always shows: Android's "remove animations" setting must not hide it
      var seen = false;
      try { seen = !!sessionStorage.getItem('tapin-intro'); } catch (e) {}
      if (!rm && (!seen || /[?&]intro=1/.test(q))) {
        document.documentElement.classList.add('intro-lock');
        // If intro.js never loads, do not trap the visitor behind it.
        setTimeout(function () { if (!window.__tapinIntro) document.documentElement.classList.remove('intro-lock'); }, 5000);
      }
    }
  } catch (e) {}
  var KEY = 'tapin-mode';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; } }
  function current() { return saved() || (mq && mq.matches ? 'light' : 'dark'); }
  function apply() {
    var m = current();
    document.documentElement.setAttribute('data-mode', m);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', m === 'light' ? '#F7F2F8' : '#2B1B2D');
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.TapTheme = {
    toggle: function () {
      var next = current() === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply();
      return next;
    },
    current: current,
    button: function () {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-btn';
      function paint() { b.textContent = current() === 'light' ? '☾' : '☀'; b.setAttribute('aria-label', 'Switch to ' + (current() === 'light' ? 'dark' : 'light') + ' mode'); }
      b.addEventListener('click', function () { window.TapTheme.toggle(); paint(); });
      paint();
      return b;
    }
  };
})();
