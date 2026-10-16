// Home page background: a slow, soft, flowing "liquid light" drawn by a small WebGL shader.
// It bends around the pointer, ripples when you tap, and drifts as you scroll. No hard shapes.
// Decoration only: without WebGL (or with reduced motion) the page falls back to the CSS glow / a still frame.
(function () {
  'use strict';
  var body = document.body;
  if (!body || !body.classList.contains('home')) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var cv = document.createElement('canvas');
  cv.id = 'liquid'; cv.setAttribute('aria-hidden', 'true');
  var gl = null;
  try { gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) || cv.getContext('experimental-webgl'); } catch (e) { gl = null; }
  if (!gl) return;

  var VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  var FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'uniform vec2 r;uniform float t;uniform vec2 m;uniform float v;uniform float s;uniform float L;uniform float hue;',
    'uniform vec3 c1;uniform vec3 c2;uniform vec3 c3;uniform vec3 hi;',
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}',
    'float fbm(vec2 p){float a=.5,x=0.;for(int i=0;i<5;i++){x+=a*n(p);p=p*2.02+vec2(1.7,9.2);a*=.5;}return x;}',
    'vec3 rot(vec3 c,float a){float k=cos(a),q=sin(a);vec3 u=vec3(.57735);return c*k+cross(u,c)*q+u*dot(u,c)*(1.-k);}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/r;',
    '  vec2 p=(gl_FragCoord.xy-.5*r)/r.y;',
    '  vec2 mm=(m-.5*r)/r.y;',
    '  float tt=t*.05+s;',
    '  vec2 q=vec2(fbm(p*1.3+tt),fbm(p*1.3+vec2(5.2,1.3)-tt));',
    '  vec2 dp=p-mm;float d=length(dp);',
    '  q+=dp*exp(-d*3.2)*(.45+v*.9);',                       // the liquid parts around the pointer
    '  vec2 w=vec2(fbm(p*1.7+3.*q+vec2(1.7,9.2)+tt*1.4),fbm(p*1.7+3.*q+vec2(8.3,2.8)-tt));',
    '  float f=fbm(p*1.5+3.4*w);',
    '  vec3 col=mix(c1,c2,smoothstep(.15,.85,f));',
    '  col=mix(col,c3,smoothstep(.25,1.1,length(q))*.6);',
    '  col+=hi*pow(f,4.)*.32*(1.-.7*L);',
    '  col+=hi*exp(-d*5.)*(.05+v*.12)*(1.-.6*L);',            // a soft light under the pointer
    '  col=rot(col,hue);',
    '  col*=1.-.32*length(uv-.5);',                           // vignette keeps text readable
    '  gl_FragColor=vec4(col,1.);',
    '}'
  ].join('\n');

  function sh(type, src) { var o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; }
  var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return;
  var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
  gl.useProgram(pr);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {}; ['r', 't', 'm', 'v', 's', 'L', 'hue', 'c1', 'c2', 'c3', 'hi'].forEach(function (k) { U[k] = gl.getUniformLocation(pr, k); });

  var PAL = {
    dark: { c1: [.11, .06, .13], c2: [.40, .27, .42], c3: [.17, .27, .70], hi: [.72, .63, .82] },
    light: { c1: [.97, .95, .97], c2: [.86, .80, .89], c3: [.76, .82, 1.0], hi: [1, 1, 1] }
  };
  function setPalette() {
    var light = document.documentElement.getAttribute('data-mode') === 'light', p = light ? PAL.light : PAL.dark;
    gl.uniform3fv(U.c1, p.c1); gl.uniform3fv(U.c2, p.c2); gl.uniform3fv(U.c3, p.c3); gl.uniform3fv(U.hi, p.hi);
    gl.uniform1f(U.L, light ? 1 : 0);
  }

  var scale = .5, W = 1, H = 1, M = { x: 0, y: 0, sx: 0, sy: 0, v: 0, on: false }, t0 = performance.now(), visible = true, slow = 0, last = t0, lastX = 0, lastY = 0;
  function size() {
    var d = Math.min(window.devicePixelRatio || 1, 1.5) * scale;
    W = Math.max(2, Math.floor(window.innerWidth * d)); H = Math.max(2, Math.floor(window.innerHeight * d));
    cv.width = W; cv.height = H; gl.viewport(0, 0, W, H); gl.uniform2f(U.r, W, H);
    if (!M.on) { M.x = M.sx = W * .62; M.y = M.sy = H * .55; }
  }
  function draw(now) {
    var dt = Math.min(80, now - last); last = now;
    // keep it smooth: if frames run slow for a while, render the liquid at a lower resolution
    if (dt > 34) slow++; else if (slow > 0) slow--;
    if (slow > 60 && scale > .32) { scale = .32; slow = 0; size(); }
    M.sx += (M.x - M.sx) * .07; M.sy += (M.y - M.sy) * .07;
    var sp = Math.min(1, Math.hypot(M.x - lastX, M.y - lastY) / (W * .04 + 1)); lastX = M.x; lastY = M.y;
    M.v += (sp - M.v) * .08; M.v *= .985;
    var hue = parseFloat(body.style.getPropertyValue('--hue')) || 0;
    gl.uniform1f(U.t, (reduce ? 14 : (now - t0) / 1000));
    gl.uniform2f(U.m, M.sx, H - M.sy);
    gl.uniform1f(U.v, M.v);
    gl.uniform1f(U.s, (window.pageYOffset || 0) * .0005);
    gl.uniform1f(U.hue, hue * Math.PI / 180);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  body.insertBefore(cv, body.firstChild);
  body.classList.add('liquid');
  setPalette(); size(); draw(performance.now());
  if (window.MutationObserver) new MutationObserver(function () { setPalette(); if (reduce) draw(performance.now()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { size(); draw(performance.now()); }, 150); });
  cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); cv.remove(); body.classList.remove('liquid'); }); // fall back to the CSS glow
  if (reduce) return;

  window.addEventListener('pointermove', function (e) { var d = W / window.innerWidth; M.x = e.clientX * d; M.y = e.clientY * d; if (!M.on) { M.sx = M.x; M.sy = M.y; } M.on = true; }, { passive: true });
  window.addEventListener('pointerdown', function () { M.v = Math.min(2, M.v + 1.1); }, { passive: true }); // a tap sends a ripple through the liquid
  document.addEventListener('visibilitychange', function () { visible = !document.hidden; last = performance.now(); });
  (function loop(now) { if (visible) draw(now); requestAnimationFrame(loop); })(performance.now());
})();
