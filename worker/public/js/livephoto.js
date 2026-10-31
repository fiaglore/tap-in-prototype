// Live photos. Each .lp[data-live] holds two layers of one photo: the lights behind (img.bg) and the dark hands and crowd in
// front (img.fg). Here both go to the graphics card, where the crowd moves like people (a slow wave rolls across it, heads
// bob on the beat, raised arms sway the most), the stage lights twinkle and pulse, beams sweep behind everybody, and a tap
// sends a ripple through the crowd. Without WebGL, or with reduced motion, the two images stay as a still photo.
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var els = Array.prototype.slice.call(document.querySelectorAll('.lp[data-live]'));
  if (!els.length || reduce) return;

  var VS = 'attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}';
  var FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'varying vec2 v;uniform sampler2D bg;uniform sampler2D fg;',
    'uniform vec4 crop;uniform float t;uniform float ca;uniform vec3 tap;uniform vec2 mouse;uniform float amp;',
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float nz(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}',
    // one light beam shining down from above the picture
    'vec3 beam(vec2 p,float ox,float base,float sw,float sp,float ph,vec3 col){',
    '  vec2 d=p-vec2(ox,-.12);float ang=atan(d.x,d.y);float df=ang-(base+sw*sin(t*sp+ph));',
    '  float core=exp(-df*df*520.)*.7+exp(-df*df*38.)*.3;',
    '  return col*core*smoothstep(1.5,.05,length(d));}',
    'void main(){',
    '  vec2 uv=crop.zw+vec2(v.x,1.-v.y)*crop.xy;',
    '  float low=uv.y;',
    '  float up=pow(clamp(1.-low,0.,1.),1.25);',                                      // raised arms: the higher, the more they sway
    '  float crowd=smoothstep(.3,.95,low);',                                          // heads and shoulders: the lower, the more they bob
    '  vec2 d=vec2(0.);',
    '  d.x+=sin(t*1.7+uv.x*5.5+uv.y*3.)*.0056*up+sin(t*3.1+uv.x*12.)*.0021*up;',
    '  d.y+=sin(t*3.25+uv.x*7.)*.0034*crowd+sin(t*1.4+uv.x*3.)*.0019*crowd;',        // bob on the beat, plus a slow wave across the crowd
    '  d.y+=sin(t*2.2+uv.x*6.)*.0024*up;',
    '  vec2 tp=crop.zw+vec2(tap.x,1.-tap.y)*crop.xy;float age=tap.z;',
    '  if(age>=0.){vec2 r=uv-tp;r.x*=ca;float dist=length(r);float w=exp(-age*1.7)*sin(dist*46.-age*11.)*exp(-dist*4.5)*.011;d+=normalize(r+1e-5)*w*vec2(1./ca,1.);}',
    '  d*=amp;',
    '  vec2 par=(mouse-.5)*vec2(.006,.003);',
    '  vec4 f=texture2D(fg,uv+d+par);',
    '  vec3 c=texture2D(bg,uv-par*.6+d*.25).rgb;',
    '  float L=dot(c,vec3(.299,.587,.114));',
    '  float lit=smoothstep(.78,.97,L);',
    '  float tw=nz(uv*vec2(26.,17.)+vec2(t*.45,-t*.7));',
    '  float pulse=.5+.5*sin(t*3.25);pulse=pulse*pulse*pulse;',
    '  c+=c*lit*(.2*pulse+.34*(tw-.5));',                                             // only the hottest stage lights twinkle
    '  c*=1.+.07*pulse;',                                                             // the whole room breathes a little on the beat
    '  vec2 p=vec2((v.x-.5)*ca,1.-v.y);',
    '  vec3 col=clamp(f.rgb+c*(1.-f.a),0.,1.);',
    '  col*=1.-.2*smoothstep(.55,1.15,length((v-.5)*vec2(1.2,1.)));',                  // a soft dark edge
    '  gl_FragColor=vec4(col,1.);}'
  ].join('\n');

  function compile(gl, type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }

  function Live(lp) {
    this.lp = lp; this.ok = false; this.visible = false; this.tap = [0, 0, -1]; this.tapAt = 0; this.mouse = [.5, .5]; this.mt = [.5, .5];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2); this.slow = 0;
    this.bgImg = lp.querySelector('img.bg'); this.fgImg = lp.querySelector('img.fg');
    this.amp = parseFloat(lp.getAttribute('data-amp')) || 1;
  }
  Live.prototype.init = function () {
    var self = this, lp = this.lp, cv = document.createElement('canvas');
    cv.className = 'lp-canvas'; cv.setAttribute('aria-hidden', 'true');
    var gl = null;
    try { gl = cv.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false }) || cv.getContext('experimental-webgl'); } catch (e) {}
    if (!gl) return false;
    var vs = compile(gl, gl.VERTEX_SHADER, VS), fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return false;
    gl.useProgram(pr);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.gl = gl; this.cv = cv; this.pr = pr;
    this.u = {}; ['bg', 'fg', 'crop', 't', 'ca', 'tap', 'mouse', 'amp'].forEach(function (n) { self.u[n] = gl.getUniformLocation(pr, n); });
    function tex(img, unit, premult) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premult ? 1 : 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    try {
      if (Math.max(this.bgImg.naturalWidth, this.bgImg.naturalHeight) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return false;
      this.tBg = tex(this.bgImg, 0, false); this.tFg = tex(this.fgImg, 1, true);
    } catch (e) { return false; }
    gl.uniform1i(this.u.bg, 0); gl.uniform1i(this.u.fg, 1);
    this.iw = this.bgImg.naturalWidth; this.ih = this.bgImg.naturalHeight;
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); self.drop(); });
    lp.insertBefore(cv, lp.firstChild);
    this.size(); this.ok = true; this.draw(0);
    lp.classList.add('lp-on');                      // the still images and CSS lights step aside
    return true;
  };
  Live.prototype.drop = function () { this.ok = false; this.lp.classList.remove('lp-on'); if (this.cv && this.cv.parentNode) this.cv.parentNode.removeChild(this.cv); };
  Live.prototype.size = function () {
    var r = this.lp.getBoundingClientRect(), w = Math.max(2, Math.round(r.width * this.dpr)), h = Math.max(2, Math.round(r.height * this.dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; this.gl.viewport(0, 0, w, h); }
  };
  Live.prototype.pos = function () {                // the --pos / --pos-m focus point, as object-position does for the still photo
    var cs = getComputedStyle(this.lp), raw = (window.innerWidth <= 760 && cs.getPropertyValue('--pos-m').trim()) || cs.getPropertyValue('--pos').trim() || '50% 40%';
    var m = raw.split(/\s+/).map(function (s) { return parseFloat(s) / 100; });
    return [isNaN(m[0]) ? .5 : m[0], isNaN(m[1]) ? .4 : m[1]];
  };
  Live.prototype.draw = function (t) {
    var gl = this.gl; if (!this.ok || !gl) return;
    var cw = this.cv.width, ch = this.cv.height, ca = cw / ch, ia = this.iw / this.ih, p = this.pos();
    var sx = 1, sy = 1, ox = 0, oy = 0;
    if (ca > ia) { sy = ia / ca; oy = (1 - sy) * p[1]; } else { sx = ca / ia; ox = (1 - sx) * p[0]; }
    var z = 1.035 + .02 * (.5 + .5 * Math.sin(t * .09));            // a slow push in and out
    var nsx = sx / z, nsy = sy / z; ox += (sx - nsx) * .5; oy += (sy - nsy) * .5;
    this.mouse[0] += (this.mt[0] - this.mouse[0]) * .05; this.mouse[1] += (this.mt[1] - this.mouse[1]) * .05;
    var age = this.tap[2] >= 0 ? t - this.tapAt : -1; if (age > 3.2) { age = -1; this.tap[2] = -1; }
    gl.uniform4f(this.u.crop, nsx, nsy, ox, oy); gl.uniform1f(this.u.t, t); gl.uniform1f(this.u.ca, ca);
    gl.uniform3f(this.u.tap, this.tap[0], this.tap[1], age); gl.uniform2f(this.u.mouse, this.mouse[0], this.mouse[1]); gl.uniform1f(this.u.amp, this.amp);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  var items = [], t0 = performance.now(), docVisible = true;
  document.addEventListener('visibilitychange', function () { docVisible = !document.hidden; });

  function ready(img, cb) { if (img.complete && img.naturalWidth) cb(); else { img.addEventListener('load', cb, { once: true }); } }
  function boot(lp) {
    var it = new Live(lp); items.push(it);
    if (!it.bgImg || !it.fgImg) return;
    var started = false;
    function go() { if (started) return; started = true; var n = 0; function one() { if (++n < 2) return; if (!it.init()) it.ok = false; } ready(it.bgImg, one); ready(it.fgImg, one); }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { it.visible = e.isIntersecting; if (e.isIntersecting) go(); }); }, { rootMargin: '300px 0px' }).observe(lp);
    } else { it.visible = true; go(); }
  }
  els.forEach(boot);

  var last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!docVisible) return;
    var dt = now - last; if (dt < 15) return; last = now;
    var t = (now - t0) / 1000;
    for (var i = items.length - 1; i >= 0; i--) {                     // the opening screen is removed from the page once it has played: give its memory back
      var gone = items[i]; if (gone.lp.isConnected) continue;
      try { var lose = gone.gl && gone.gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) {}
      gone.ok = false; items.splice(i, 1);
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i]; if (!it.ok || !it.visible) continue;
      it.size(); it.draw(t);
      if (dt > 42) { it.slow++; if (it.slow > 40 && it.dpr > 1) { it.dpr = 1; it.slow = 0; } } else if (it.slow > 0) it.slow--;   // slow device: draw smaller
    }
  }
  requestAnimationFrame(frame);

  // taps and the pointer reach the crowd
  document.addEventListener('pointerdown', function (e) {
    var t = (performance.now() - t0) / 1000;
    items.forEach(function (it) {
      if (!it.ok || !it.visible) return;
      var r = it.lp.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      it.tap = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, 0]; it.tapAt = t;
    });
  }, { passive: true });
  document.addEventListener('pointermove', function (e) {
    items.forEach(function (it) {
      if (!it.ok || !it.visible) return;
      var r = it.lp.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom) return;
      it.mt = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    });
  }, { passive: true });
})();
