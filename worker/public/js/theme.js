// Classic script loaded in <head> so the right colours apply before first paint.
(function () {
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
