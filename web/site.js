/* site.js - this page's own choreography.
   The engine (scrollcraft.js) owns the scroll track, the leg opacities and the
   copy windows. This file owns what happens inside them: the layered campus and
   its push-in, the rulebook rush and collapse, the scan-line scrollbar, and keeping
   the chat desk out of the tab order until it is actually on screen. */
(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Automated captures get settled frames. A screenshot taken mid-glide is a
  // frame the page never holds at rest, and it makes every run unrepeatable.
  var settled = reduce || navigator.webdriver === true;
  var fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var phone = matchMedia('(max-width: 760px)');

  var root = document.querySelector('[data-sc-mode="worldflight"]');
  if (!root) return;

  // ---- the track, in viewport-heights, read from the same weights the engine uses
  var W = [].map.call(root.querySelectorAll('[data-sc-segment]'), function (el) {
    return parseFloat(el.getAttribute('data-sc-w')) || 1.3;
  });
  var C = [], total = 0;
  W.forEach(function (w) { C.push(total); total += w; });

  // ---- math
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function c01(v) { return clamp(v, 0, 1); }
  function smooth(v) { v = c01(v); return v * v * (3 - 2 * v); }
  function ramp(v, a, b) { return smooth((v - a) / (b - a)); }
  function easeInOut(v) { v = c01(v); return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function T(x, y, s) {
    return 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + s.toFixed(4) + ')';
  }
  function placed(x, y, s) {   // centred on the anchor, then moved and scaled
    return 'translate(-50%,-50%) ' + T(x, y, s);
  }

  // Write a style only when it changes. Most frames change a handful of values.
  function css(el, prop, val) {
    var k = '_sc_' + prop;
    if (el[k] !== val) { el[k] = val; el.style[prop] = val; }
  }
  function cssVar(el, name, val) {
    var k = '_sc_' + name;
    if (el[k] !== val) { el[k] = val; el.style.setProperty(name, val); }
  }

  // ---- elements
  var campus = root.querySelector('.campus');
  function plane(n) { return campus.querySelector('.plane--' + n); }
  var pPoster = plane('poster'), pSky = plane('sky'), pHoi = plane('hoi'), pBuilding = plane('building'),
      pBloom = plane('bloom'), pLamp = plane('lamp'), pBlur = plane('blur'), pTint = plane('tint'),
      pGrade = plane('grade');
  var hoi = campus.querySelector('.hoi');
  var hoiWord = hoi.querySelector('.hoi__word');
  var hoiBase = hoi.querySelector('.hoi__base');

  var rule = root.querySelector('.rulebook');
  var qbar = rule.querySelector('.qbar');
  var qtext = qbar.querySelector('.qbar__text');
  var QUESTION = 'What IELTS score do I need?';
  var card = rule.querySelector('.answer');
  var cardS = +card.dataset.s, cardX = +card.dataset.x, cardY = +card.dataset.y;
  var frags = [].map.call(rule.querySelectorAll('.frag'), function (el, i) {
    var f = { el: el, s: +el.dataset.s, x: parseFloat(el.dataset.x), y: parseFloat(el.dataset.y) };
    if (isNaN(f.x) || isNaN(f.y)) {
      // The stream: spread round the centre on a golden-angle spiral, so lines
      // fly past the camera on every side and never straight into it.
      var a = i * 2.39996, rad = 0.2 + 0.24 * ((i * 0.618034) % 1);
      f.x = Math.cos(a) * rad * 1.3;
      f.y = Math.sin(a) * rad * 0.9;
    }
    return f;
  });
  var words = splitWords(card.querySelector('.answer__plain'));

  // Every fragment travels at the same speed, so depth order never changes: a
  // smaller phase is always nearer the camera. Set it once.
  frags.forEach(function (f) { f.el.style.zIndex = String(1000 - Math.round(f.s * 100)); });
  card.style.zIndex = reduce ? '2000' : String(1000 - Math.round(cardS * 100));

  var desk = document.getElementById('ask');
  var input = desk ? desk.querySelector('textarea') : null;
  var rail = document.querySelector('.rail');
  var stops = [].slice.call(document.querySelectorAll('.rail__stop'));

  function splitWords(p) {
    var out = [];
    [].slice.call(p.childNodes).forEach(function (n) {
      if (n.nodeType === 3) {
        var frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
          var s = document.createElement('span');
          s.className = 'w';
          s.textContent = part;
          frag.appendChild(s);
          out.push(s);
        });
        p.replaceChild(frag, n);
      } else if (n.nodeType === 1) {
        var w = document.createElement('span');
        w.className = 'w';
        p.replaceChild(w, n);
        w.appendChild(n);
        out.push(w);
      }
    });
    return out;
  }

  // ---- geometry of the photograph -------------------------------------------
  // Measured on the plates (see src-plates/make_plates_v2.py), in plate pixels:
  // the span of skyline "Hoi" rises from behind, the line it rises from, and
  // where the lamp stands, plus the object-position each plate is shown at.
  //   desktop: the open sky right of the glass box, behind the canopy and trees
  //   phone:   on the roof of the glass box, the sky above it
  var PLATES = {
    d: { w: 1536, h: 1024, px: 0.5, py: 0.4, hoi: { left: 862, right: 1360, base: 424, tuck: 0.1 }, lamp: [997, 520] },
    m: { w: 660, h: 1024, px: 0.53, py: 0.5, hoi: { left: -143, right: 440, base: 220, tuck: 0.12 }, lamp: [697, 520] }
  };
  var vw = 0, vh = 0, rootTop = 0, barH = 76, qTopY = 0, cardFinalY = 0;

  function glyphHeight(ch, fallback) {     // ink height of a glyph, per em, in the face that loaded
    try {
      var cs = getComputedStyle(hoi);
      var g = glyphHeight.g || (glyphHeight.g = document.createElement('canvas').getContext('2d'));
      g.font = cs.fontWeight + ' 100px ' + cs.fontFamily;
      if ('fontStretch' in g) g.fontStretch = 'expanded';
      var a = g.measureText(ch).actualBoundingBoxAscent;
      if (a > 30 && a < 95) return a / 100;
    } catch (e) { /* fall through */ }
    return fallback;
  }
  function capRatio() { return glyphHeight('H', 0.72); }

  // "Hoi" fills a span of sky and sits ON the skyline: its baseline is seated a
  // little below the line, so the campus hides the foot of every letter and is
  // in front of the word before anything moves.
  function layoutHero() {
    var pl = phone.matches ? PLATES.m : PLATES.d;
    var s = Math.max(vw / pl.w, vh / pl.h);
    var ox = (vw - pl.w * s) * pl.px, oy = (vh - pl.h * s) * pl.py;
    var lamp = [ox + pl.lamp[0] * s, oy + pl.lamp[1] * s];
    cssVar(doc, '--lamp-x', (lamp[0] / vw * 100).toFixed(2) + '%');
    cssVar(doc, '--lamp-y', (lamp[1] / vh * 100).toFixed(2) + '%');

    hoi.style.removeProperty('--hoi-left');
    hoi.style.setProperty('--hoi-size', '100px');            // measure in the face that actually loaded
    var gutter = parseFloat(getComputedStyle(hoi).left) || 20;
    var w100 = hoiWord.offsetWidth || 170;
    var b100 = hoiBase.offsetTop || 70;                       // baseline, from the top of the line box
    var cap = capRatio();
    var left = Math.max(gutter, ox + pl.hoi.left * s);
    var right = Math.min(vw - gutter, ox + pl.hoi.right * s);
    var line = oy + pl.hoi.base * s;

    var fs = Math.min(Math.max(120, right - left) / w100 * 100,               // stay over the span
                      (line - barH - vh * 0.035) / ((1 - pl.hoi.tuck) * cap),    // and clear the bar
                      vh * 0.45);
    fs = Math.max(56, fs);
    var baseline = line + cap * fs * pl.hoi.tuck;
    hoi.style.setProperty('--hoi-left', left.toFixed(1) + 'px');
    hoi.style.setProperty('--hoi-size', fs.toFixed(1) + 'px');
    hoi.style.setProperty('--hoi-top', (baseline - b100 * fs / 100).toFixed(1) + 'px');
    // the dot of the i sits where a dot belongs: a small gap above the x-height
    var xh = glyphHeight('x', 0.52), dot = 0.11;
    hoi.style.setProperty('--dot-y', (b100 / 100 - xh - 0.075 - dot).toFixed(3) + 'em');
  }

  function layout() {
    vw = innerWidth; vh = innerHeight;
    if (!vw || !vh) return;
    rootTop = root.getBoundingClientRect().top + scrollY;
    barH = parseFloat(getComputedStyle(doc).getPropertyValue('--bar-h')) || 76;
    layoutHero();
    var qh = qbar.offsetHeight || 60;
    qTopY = (barH + vh * 0.025 + qh * 0.43) - vh * 0.46;      // where the question parks during the rush
    cardFinalY = vh * (phone.matches ? 0.07 : 0.06);
    nlmap.layout();
    layoutRail();
    frags.forEach(function (f) { f.w = f.el.offsetWidth; f.h = f.el.offsetHeight; });
    kick();
  }

  // ---- the campus: a layered push-in that melts into blur --------------------
  var ready = false;

  function heroFrame(t, mx, my) {
    // Answers from the first pixel of scroll (an ease-in would sit still while the
    // reader starts), then settles as the campus melts into blur.
    var p0 = c01(t / W[0]), e0 = 0.6 * (1 - (1 - p0) * (1 - p0)) + 0.4 * easeInOut(p0);
    var after = c01((t - W[0]) / (total - W[0]));
    var q = (t - C[1]) / W[1];
    // the world leans in during the rush and lets go through the hush
    var rush = smooth((q - 0.2) / 0.42) * (1 - smooth((q - 0.62) / 0.24));

    var blurOp = ramp(p0, 0.38, 0.93);
    css(pBlur, 'opacity', blurOp.toFixed(3));
    css(pTint, 'opacity', (0.32 * blurOp).toFixed(3));     // the melted campus turns night blue
    css(pHoi, 'opacity', (1 - ramp(p0, 0.3, 0.7)).toFixed(3));
    css(pGrade, 'opacity', (0.35 + 0.45 * e0 + 0.2 * rush).toFixed(3));
    if (reduce) return;

    var k = 1 - e0;                     // the pointer only steers the opening frame
    mx *= k; my *= k;
    var bs = 1 + 0.30 * e0;
    var bt = T(-mx * 16, -my * 10, bs);
    css(pSky, 'transform', T(-mx * 6, -0.015 * vh * e0 - my * 4, 1 + 0.06 * e0));
    css(pHoi, 'transform', T(-mx * 10, 0.05 * vh * e0 - my * 7, 1 - 0.05 * e0));
    css(pBuilding, 'transform', bt);
    css(pBloom, 'transform', bt);
    if (!ready) css(pPoster, 'transform', bt);
    css(pLamp, 'transform', T(-mx * 26, 0.26 * vh * e0 - my * 16, 1 + 0.6 * e0));
    css(pBlur, 'transform', T(-mx * 16, -my * 10, bs + 0.06 * after + 0.035 * rush));
  }

  // ---- the rulebook ---------------------------------------------------------
  // q is progress through the leg. 0.03-0.18 the question types itself,
  // 0.18-0.28 it parks under the bar, 0.20-0.62 the rush, 0.62-0.70 the hush,
  // 0.70-0.86 the collapse into the answer, 0.86-0.93 it holds, then leaves.
  var typed = -1, ruleOn = true;

  function neonOn(h) {                 // a tube striking: two stutters, then steady
    if (reduce) return smooth(h);
    if (h <= 0) return 0;
    if (h < 0.12) return 0.75 * (h / 0.12);
    if (h < 0.2) return 0.12;
    if (h < 0.38) return 0.9;
    if (h < 0.44) return 0.3;
    return 0.85 + 0.15 * smooth((h - 0.44) / 0.3);
  }

  function ruleFrame(t) {
    var q = (t - C[1]) / W[1];
    if (q < -0.06 || q > 1.06) {
      if (ruleOn) {
        ruleOn = false;
        frags.forEach(function (f) { css(f.el, 'opacity', '0'); css(f.el, 'visibility', 'hidden'); });
        css(card, 'opacity', '0'); css(card, 'visibility', 'hidden');
        css(qbar, 'opacity', '0');
      }
      return;
    }
    ruleOn = true;

    // the question, typed by the reader's own scroll
    var n = Math.round(c01((q - 0.03) / 0.15) * QUESTION.length);
    if (n !== typed) { typed = n; qtext.textContent = QUESTION.slice(0, n); }
    qbar.classList.toggle('is-sent', q > 0.19);
    var rise = reduce ? 1 : easeInOut((q - 0.18) / 0.1);
    css(qbar, 'opacity', (ramp(q, 0, 0.05) * (1 - ramp(q, 0.62, 0.7))).toFixed(3));
    css(qbar, 'transform', placed(0, qTopY * rise, 1 - 0.14 * rise));

    var r = c01((q - 0.2) / 0.42);
    var hush = ramp(q, 0.62, 0.7);
    // As the map locks onto the VU, the lines over the target and its label
    // fade and drift aside, so the campus can be seen. The survivor is spared.
    var fz = nlmap.focus(t), zx0 = 0, zx1 = 0, zy0 = 0, zy1 = 0;
    if (fz.k > 0.001) {
      if (phone.matches) { zx0 = 0; zx1 = vw; zy0 = fz.y - 50; zy1 = fz.y + 115; }
      else { zx0 = fz.x - 70; zx1 = fz.x + 340; zy0 = fz.y - 75; zy1 = fz.y + 75; }
    }
    var zcx = (zx0 + zx1) / 2, zcy = (zy0 + zy1) / 2;
    var col = c01((q - 0.7) / 0.16), colE = easeInOut(col);

    // Real lines, flown at the reader. u is each line's progress from the far
    // end of the field (0) to past the camera (1); the projection is done here,
    // so nothing depends on a 3D context surviving the faded leg around it.
    for (var i = 0; i < frags.length; i++) {
      var f = frags[i], u, sc, op;
      if (reduce) {
        u = f.s >= 1.3 ? 2.2 - f.s : 0.55 + 0.3 * ((i * 0.618) % 1);   // held in place, spread wide
        sc = 1 / (4 - 3.5 * u);
        var at = 0.2 + 0.3 * (i / frags.length);                       // staggered, all in before the hush
        op = ramp(q, at, at + 0.1);
      } else {
        u = r * 2.2 - f.s;
        sc = 1 / Math.max(0.3, 4 - 3.5 * u + 1.8 * colE);
        op = ramp(u, 0.02, 0.2) * (1 - ramp(u, 0.84, 0.95));
      }
      op *= (0.55 + 0.45 * Math.min(1, sc)) * (1 - 0.65 * hush) * (1 - colE);
      var px = f.x * vw * sc, py = f.y * vh * sc;
      if (fz.k > 0.001 && f.w) {
        var hw = f.w * sc / 2, hh = f.h * sc / 2, fcx = vw * 0.5 + px, fcy = vh * 0.46 + py;
        var ovx = Math.min(fcx + hw, zx1) - Math.max(fcx - hw, zx0);
        var ovy = Math.min(fcy + hh, zy1) - Math.max(fcy - hh, zy0);
        var ov = Math.min(ovx, ovy);
        if (ov > -40) {
          var cl = fz.k * smooth((ov + 40) / 80);
          op *= 1 - cl;
          var dx = fcx - zcx, dy = fcy - zcy, dl = Math.sqrt(dx * dx + dy * dy) || 1;
          if (!reduce) { px += dx / dl * 70 * cl; py += dy / dl * 70 * cl; }
        }
      }
      if (op < 0.004) { css(f.el, 'opacity', '0'); css(f.el, 'visibility', 'hidden'); continue; }
      css(f.el, 'visibility', 'visible');
      css(f.el, 'opacity', op.toFixed(3));
      css(f.el, 'transform', placed(px, py, sc));
    }

    // The survivor. It flies in as one of the lines, freezes with the rest,
    // lights up in the hush, then lifts out of the field and becomes the answer.
    var uC = reduce ? 2.2 - cardS : r * 2.2 - cardS;
    var scF = 1 / Math.max(0.3, 4 - 3.5 * uC);
    var mv = reduce ? 1 : colE;
    var out = ramp(q, 0.93, 1);
    var cop = (reduce ? ramp(q, 0.24, 0.34) : ramp(uC, 0.02, 0.2)) * (1 - out);
    css(card, 'visibility', cop < 0.004 ? 'hidden' : 'visible');
    css(card, 'opacity', cop.toFixed(3));
    css(card, 'transform', placed(
      lerp(cardX * vw * scF, 0, mv),
      lerp(cardY * vh * scF, cardFinalY, mv) - (reduce ? 0 : 0.03 * vh * out),
      lerp(scF, 1, mv)));
    cssVar(card, '--lit', (neonOn(hush) * (1 - 0.45 * ramp(q, 0.86, 0.93))).toFixed(3));
    cssVar(card, '--a-q', ramp(col, 0.2, 0.5).toFixed(3));
    cssVar(card, '--a-legal', (1 - ramp(col, 0.3, 0.55)).toFixed(3));
    cssVar(card, '--a-src', ramp(col, 0.82, 1).toFixed(3));
    for (var j = 0; j < words.length; j++) {
      var w0 = 0.42 + 0.38 * (j / Math.max(1, words.length - 1));
      var wo = ramp(col, w0, w0 + 0.08);
      css(words[j], 'opacity', wo.toFixed(3));
      if (!reduce) css(words[j], 'transform', wo >= 1 ? 'none' : 'translate3d(0,' + ((1 - wo) * 0.3).toFixed(3) + 'em,0)');
    }
  }

  // ---- the Netherlands, and the dive to the VU -----------------------------------
  // Behind the rulebook, the country as a grid of tiny squares. Squares light in
  // a wave from the VU outward; then, while the rules rush in, the camera dives
  // from the whole country to the A10 ring and down to the campus on De Boelelaan,
  // and locks on just as the one rule that answers the question lights up.
  // The grid is fixed to the screen and the map flows under it, the way a dot
  // display redraws. Geography comes from two baked layers (src-plates/make_map.py):
  // Natural Earth 1:10m for the country, and an Amsterdam layer whose A10 runs
  // through real anchor points (Sloterdijk, Lelylaan, Zuid and RAI stations).
  var nlmap = (function () {
    var cv = campus.querySelector('.plane--map');
    if (!cv || !cv.getContext) return { layout: function () {}, update: function () {} };
    var g = cv.getContext('2d');
    var K = Math.cos(52.2 * Math.PI / 180);
    var VU = [4.8657, 52.3341];                       // De Boelelaan 1105
    var MAXD = 1.7267;                                // farthest Dutch land from the VU, in degrees
    var LON0 = 3.3, LON1 = 7.3, LAT0 = 50.7, LAT1 = 53.56;   // the country's frame before the dive
    var ASPECT = ((LON1 - LON0) * K) / (LAT1 - LAT0);
    var FINAL_SPAN = 0.05;                            // latitude on screen at the end: about 5.5 km
    // classes: 0 sea, 1 land, 2 built-up, 3 water, 4 motorway, 5 the campus
    var UNLIT = [0, 0.28, 0.34, 0, 0.4, 0.5];
    var LAYERS = [
      { src: 'assets/map-ams.png', b: [4.62, 52.22, 5.14, 52.50] },     // the finer layer wins
      { src: 'assets/map-nl.png',  b: [3.2, 50.6, 7.4, 53.7] }
    ];
    var loaded = 0;
    LAYERS.forEach(function (L) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        var x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        var px = x.getImageData(0, 0, c.width, c.height).data;
        var d = new Uint8Array(c.width * c.height);
        for (var i = 0; i < d.length; i++) d[i] = Math.round(px[i * 4] / 40);
        L.w = c.width; L.h = c.height; L.data = d;
        if (++loaded === LAYERS.length && tNow >= 0) draw(performance.now());
      };
      img.src = L.src;
    });
    function cls(lon, lat) {
      for (var i = 0; i < LAYERS.length; i++) {
        var L = LAYERS[i], b = L.b;
        if (!L.data || lon < b[0] || lon >= b[2] || lat < b[1] || lat >= b[3]) continue;
        return L.data[(((b[3] - lat) / (b[3] - b[1]) * L.h) | 0) * L.w + (((lon - b[0]) / (b[2] - b[0]) * L.w) | 0)];
      }
      return 0;
    }

    var cols = 0, rows = 0, pitch = 7, sq = 2.4, dpr = 1, ox = 0, oy = 0, W0 = 0;
    var s0 = 1, s1 = 1, p0x = 0, p0y = 0, p1x = 0, p1y = 0, gutter = 24;
    var noise = null, phase = null, tNow = -1, raf = 0;

    function hash(i) { i = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); i ^= i >>> 13; i = Math.imul(i, 0xc2b2ae35); return ((i ^ (i >>> 16)) >>> 0) / 4294967296; }

    function layoutMap() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
      W0 = vw;
      var mh = phone.matches ? Math.min(vh * 0.62, (vw * 0.94) / ASPECT) : vh * 0.84;
      var mw = mh * ASPECT;
      var bx = (vw - mw) / 2, by = (vh - mh) / 2 + vh * 0.03;
      s0 = mh / (LAT1 - LAT0);
      p0x = bx + (VU[0] - LON0) * K * s0;
      p0y = by + (LAT1 - VU[1]) * s0;
      s1 = vh / FINAL_SPAN;
      p1x = vw * (phone.matches ? 0.5 : 0.36);
      p1y = vh * (phone.matches ? 0.66 : 0.6);
      pitch = Math.max(4.5, mh / 112);
      sq = Math.max(1.5, pitch * 0.36);
      gutter = Math.max(20, Math.min(56, vw * 0.04));
      ox = ((bx + pitch / 2) % pitch + pitch) % pitch;
      oy = ((by + pitch / 2) % pitch + pitch) % pitch;
      cols = Math.ceil((vw - ox) / pitch) + 1; rows = Math.ceil((vh - oy) / pitch) + 1;
      noise = new Float32Array(cols * rows); phase = new Float32Array(cols * rows);
      for (var i = 0; i < noise.length; i++) { noise[i] = hash(i * 2 + 1); phase[i] = hash(i * 2 + 7) * 6.283; }
      draw(performance.now());
    }

    function bump(x) { return x > 0 && x < 1.6 ? Math.sin(x / 1.6 * Math.PI) : 0; }

    // where the camera is: the VU's place on screen, and pixels per degree of latitude
    function camera(q) {
      var zq = c01((q - 0.28) / 0.34);
      if (reduce) zq = q < 0.5 ? 0 : 1;            // a cut, not a flight
      var z = reduce ? zq : easeInOut(zq);
      var m = reduce ? zq : smooth(c01((q - 0.28) / 0.3));
      return { z: z, s: Math.exp(lerp(Math.log(s0), Math.log(s1), z)), x: lerp(p0x, p1x, m), y: lerp(p0y, p1y, m) };
    }

    // rects collected per bucket, then filled once per bucket
    var NB = 24, bucketsB = [], bucketsW = [], halos = [];
    for (var bi = 0; bi < NB; bi++) { bucketsB.push([]); bucketsW.push([]); halos.push([]); }
    function fillBuckets(list, rgb, scale) {
      for (var b = 0; b < NB; b++) {
        var L = list[b]; if (!L.length) continue;
        g.fillStyle = 'rgba(' + rgb + ',' + Math.min(1, (b + 0.5) / NB * scale).toFixed(3) + ')';
        g.beginPath();
        for (var i = 0; i < L.length; i += 3) g.rect(L[i], L[i + 1], L[i + 2], L[i + 2]);
        g.fill();
        L.length = 0;
      }
    }

    function draw(now) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      if (tNow < 0 || !noise || loaded < LAYERS.length) return 0;
      var q = (tNow - C[1]) / W[1];
      var level = smooth((q + 0.03) / 0.06)                     // appears as the rulebook begins
                * (1 - 0.5 * ramp(q, 0.62, 0.7))                 // the hush belongs to one light
                * (1 - 0.3 * ramp(q, 0.7, 0.9));                 // quiet behind the answer and the desk
      var levelV = smooth((q + 0.03) / 0.06) * (1 - 0.3 * ramp(q, 0.7, 0.9));   // the campus doesn't hush
      if (reduce) { var dip = Math.min(1, Math.abs(q - 0.5) / 0.05); level *= dip; levelV *= dip; }
      if (level < 0.005) return 0;
      var wave = c01(q / 0.34) * 1.1;                           // the whole country lit before the dive
      var time = settled ? 0 : now / 1000;
      var cam = camera(q), s = cam.s, sK = s * K, z = cam.z;
      var dens = 1 - 0.6 * z;                                   // a full screen of land needs fewer lights
      var focusR = Math.max(vw, vh) * 0.55, K2 = K * K, dLat, dLon;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      var unlit = [[], [], [], [], [], []], sea = [];
      var h = sq / 2;
      for (var r = 0; r < rows; r++) {
        var sy = oy + r * pitch, lat = VU[1] - (sy - cam.y) / s;
        for (var c = 0; c < cols; c++) {
          var sx = ox + c * pitch, lon = VU[0] + (sx - cam.x) / sK;
          var k = cls(lon, lat), idx = r * cols + c, n = noise[idx];
          if (k === 0 || k === 3) { if (n < 0.16) sea.push(sx, sy); continue; }
          unlit[k].push(sx - h, sy - h);

          dLon = lon - VU[0]; dLat = lat - VU[1];
          var d = Math.sqrt(dLon * dLon * K2 + dLat * dLat) / MAXD;
          var x = (wave - (0.82 * d + 0.16 * n)) / 0.03;
          if (x <= 0) continue;
          if (k < 3 && n < 0.5 * z) continue;                    // close in, the city thins to scattered lights
          var on = smooth(x), flare = bump(x);
          var flick = reduce ? 1 : 0.8 + 0.2 * Math.sin(time * (1.3 + n * 2.4) + phase[idx]);
          var inten, white = flare > 0.5, grow = 0;
          if (k === 1) inten = (0.55 + 0.31 * n) * dens;
          else if (k === 2) { inten = (0.72 + 0.28 * n) * dens; white = white || n > 0.8; grow = 0.2; }
          else if (k === 4) {                                    // motorways carry pulses toward the VU
            inten = 0.75 + 0.25 * Math.sin(time * 2.4 + d * MAXD * 111 * 0.9);
            white = true; grow = 0.25 + 0.2 * z;
          } else { inten = 0.85 + 0.15 * Math.sin(time * 3.2); white = true; grow = 0.45; }
          if (z > 0.01) {                                        // close in, the edges fall away
            var fdx = sx - cam.x, fdy = sy - cam.y, fd = Math.sqrt(fdx * fdx + fdy * fdy) / focusR;
            inten *= 1 - 0.55 * z * smooth(fd);
          }
          var a = (k === 5 ? levelV : level) * on * flick * inten;
          var sz = sq * (1 + 0.9 * flare + grow);
          var bkt = Math.min(NB - 1, (a * NB) | 0);
          (white ? bucketsW : bucketsB)[bkt].push(sx - sz / 2, sy - sz / 2, sz);
          if (flare > 0.02 || k === 5 || (k === 4 && z > 0.4)) {
            var ha = 0.22 * (k === 5 ? levelV : level) * Math.max(flare, k === 5 ? 0.8 : k === 4 ? 0.35 * z : 0);
            var hs = sz * 3.2;
            halos[Math.min(NB - 1, ((ha / 0.3) * NB) | 0)].push(sx - hs / 2, sy - hs / 2, hs);
          }
        }
      }

      // the sea and the unlit country: a faint digital grid
      g.fillStyle = 'rgba(127,184,240,' + (0.06 * level).toFixed(3) + ')';
      g.beginPath();
      for (var i = 0; i < sea.length; i += 2) g.rect(sea[i] - h * 0.7, sea[i + 1] - h * 0.7, sq * 0.7, sq * 0.7);
      g.fill();
      for (var kk = 1; kk < 6; kk++) {
        var U = unlit[kk]; if (!U.length) continue;
        g.fillStyle = 'rgba(127,184,240,' + (UNLIT[kk] * level * (kk < 3 ? 1 - 0.55 * z : 1)).toFixed(3) + ')';
        g.beginPath();
        for (var j = 0; j < U.length; j += 2) g.rect(U[j], U[j + 1], sq, sq);
        g.fill();
      }

      // the lit squares
      g.globalCompositeOperation = 'lighter';
      fillBuckets(halos, '127,184,240', 0.3);
      fillBuckets(bucketsB, '127,184,240', 1);
      fillBuckets(bucketsW, '225,240,255', 1);
      g.globalCompositeOperation = 'source-over';

      hud(q, cam, level, time);
      return level;
    }

    // ---- the lock-on, and a scale bar while descending ----
    var LABEL = ['VU AMSTERDAM', 'DE BOELELAAN 1105', '52.334° N  4.866° E'];
    var NICE = [200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2];
    function hud(q, cam, level, time) {
      var mono = '"JetBrains Mono", ui-monospace, Menlo, monospace';
      var lk = reduce ? ramp(q, 0.5, 0.56) : smooth(c01((q - 0.55) / 0.09));
      var vis = lk * (1 - ramp(q, 0.74, 0.84));
      if (vis > 0.01) {
        var vx = cam.x, vy = cam.y, small = phone.matches;
        var hs = lerp(small ? 90 : 130, small ? 20 : 26, lk), arm = 9;
        g.strokeStyle = 'rgba(127,184,240,' + (0.95 * vis).toFixed(3) + ')';
        g.lineWidth = 2;
        g.beginPath();
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (s) {
          var cx = vx + s[0] * hs, cy = vy + s[1] * hs;
          g.moveTo(cx - s[0] * arm, cy); g.lineTo(cx, cy); g.lineTo(cx, cy - s[1] * arm);
        });
        g.stroke();
        if (!settled && !reduce && lk > 0.98) {            // a ping from the campus
          var ph = (time * 0.8) % 1;
          g.strokeStyle = 'rgba(127,184,240,' + (0.5 * (1 - ph) * vis).toFixed(3) + ')';
          g.lineWidth = 1;
          g.strokeRect(vx - hs * (0.4 + ph), vy - hs * (0.4 + ph), hs * 2 * (0.4 + ph), hs * 2 * (0.4 + ph));
        }
        var lab = ramp(q, 0.6, 0.67) * (1 - ramp(q, 0.72, 0.8));
        if (lab > 0.01) {
          var total = LABEL.join('').length, shown = Math.round(lab * total * 1.0), used = 0;
          g.font = '500 ' + (small ? 10 : 11) + 'px ' + mono;
          g.textBaseline = 'middle';
          var lx = small ? gutter : vx + hs + 22, ly = small ? vy + hs + 30 : vy - 16;   // phone: clear of the scrollbar tag
          var tw = 0;
          for (var m = 0; m < LABEL.length; m++) tw = Math.max(tw, g.measureText(LABEL[m]).width);
          var plx = lx - 10, ply = ly - 15, plw = tw + 20, plh = 16 * (LABEL.length - 1) + 30;
          g.fillStyle = 'rgba(5,10,18,' + (0.84 * lab).toFixed(3) + ')';
          g.fillRect(plx, ply, plw, plh);
          g.strokeStyle = 'rgba(127,184,240,' + (0.9 * lab).toFixed(3) + ')';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(plx, ply + 7); g.lineTo(plx, ply); g.lineTo(plx + 7, ply);
          g.moveTo(plx + plw - 7, ply + plh); g.lineTo(plx + plw, ply + plh); g.lineTo(plx + plw, ply + plh - 7);
          g.stroke();
          g.strokeStyle = 'rgba(127,184,240,' + (0.6 * lab).toFixed(3) + ')';
          g.lineWidth = 1;
          g.beginPath();
          if (small) { g.moveTo(vx, vy + hs); g.lineTo(vx, ply); }
          else { g.moveTo(vx + hs, vy - hs * 0.6); g.lineTo(plx, ply + 9); }
          g.stroke();
          for (var i = 0; i < LABEL.length; i++) {
            var line = LABEL[i], n = Math.max(0, Math.min(line.length, shown - used)); used += line.length;
            if (!n) break;
            g.fillStyle = i === 0 ? 'rgba(232,242,253,' + lab.toFixed(3) + ')' : 'rgba(127,184,240,' + lab.toFixed(3) + ')';
            g.fillText(line.slice(0, n), lx, ly + i * 16);
          }
        }
      }
      // scale bar: real distance at the current zoom
      var sb = ramp(q, 0.26, 0.32) * (1 - ramp(q, 0.66, 0.74)) * Math.min(1, level * 1.5);
      if (sb > 0.01 && !phone.matches) {
        var pxKm = cam.s / 111.32, km = NICE[NICE.length - 1];
        for (var j = 0; j < NICE.length; j++) { if (NICE[j] * pxKm <= 150) { km = NICE[j]; break; } }
        var L = km * pxKm, bx = gutter, by = vh - 42;
        g.strokeStyle = 'rgba(127,184,240,' + (0.8 * sb).toFixed(3) + ')';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(bx, by - 5); g.lineTo(bx, by); g.lineTo(bx + L, by); g.lineTo(bx + L, by - 5);
        g.stroke();
        g.font = '500 11px ' + mono;
        g.textBaseline = 'alphabetic';
        g.fillStyle = 'rgba(200,222,245,' + (0.9 * sb).toFixed(3) + ')';
        g.fillText(km >= 1 ? km + ' KM' : Math.round(km * 1000) + ' M', bx, by - 10);
      }
    }

    var lastT = -1, lastDraw = 0;
    function loop(now) {
      raf = 0;
      if (tNow === lastT && now - lastDraw < 30) { raf = requestAnimationFrame(loop); return; }   // idle: half rate
      lastT = tNow; lastDraw = now;
      var level = draw(now);
      if (level > 0.005 && !settled) raf = requestAnimationFrame(loop);
    }

    return {
      layout: layoutMap,
      focus: function (t) {
        var q = (t - C[1]) / W[1];
        if (!W0 || q < 0.45 || q > 0.95) return { x: 0, y: 0, k: 0 };
        var cam = camera(q);
        var k = (reduce ? ramp(q, 0.5, 0.56) : smooth(c01((q - 0.52) / 0.08))) * (1 - ramp(q, 0.8, 0.9));
        return { x: cam.x, y: cam.y, k: k };
      },
      update: function (t) {
        tNow = t;
        if (!W0) return;
        if (settled) { draw(0); return; }
        if (!raf) raf = requestAnimationFrame(loop);
      }
    };
  })();

  // ---- the rail: the page's own scrollbar, redrawn ---------------------------
  // The square follows the real scroll position, not the eased one, so it is
  // always exactly where a scrollbar thumb would be. The tag beside it names
  // the page, and decodes itself like a terminal when the page changes.
  var rTrack = rail && rail.querySelector('.rail__track');
  var rName = rail && rail.querySelector('.rail__name');
  var rTag = rail && rail.querySelector('.rail__tag');
  var NAMES = stops.map(function (b) { return b.getAttribute('data-name') || ''; });
  var trackTop = 0, trackH = 1, maxY = 1, railP = -1, railK = -1, railTuck = null, moveT = 0;

  function layoutRail() {
    if (!rail) return;
    var r = rTrack.getBoundingClientRect();
    trackTop = r.top; trackH = Math.max(1, r.height);
    maxY = Math.max(1, doc.scrollHeight - vh);
    stops.forEach(function (b, i) {
      var y = i ? rootTop + C[i] * vh : 0;
      b.parentNode.style.top = (c01(y / maxY) * 100).toFixed(3) + '%';
    });
    railP = -1;
  }

  var GLYPHS = '#%&*+/<>=_|01ABCDEFHKMNRSTXZ';
  var scramble = 0;
  function sayPage(text) {
    if (!rName) return;
    cancelAnimationFrame(scramble);
    if (settled) { rName.textContent = text; return; }
    var t0 = performance.now(), D = 380;
    (function step(now) {
      var k = c01((now - t0) / D), n = Math.floor(k * text.length), out = text.slice(0, n);
      for (var i = n; i < text.length; i++) {
        out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      rName.textContent = out;
      if (k < 1) scramble = requestAnimationFrame(step);
    })(t0);
  }

  function railFrame() {
    if (!rail) return;
    var y = scrollY, p = c01(y / maxY);
    if (Math.abs(p - railP) > 1e-5) {
      if (railP >= 0 && !settled) {
        rail.classList.add('is-moving');
        clearTimeout(moveT);
        moveT = setTimeout(function () { rail.classList.remove('is-moving'); }, 420);
      }
      railP = p;
      cssVar(rail, '--rail-y', (p * trackH).toFixed(1) + 'px');
      cssVar(rail, '--rail-p', p.toFixed(4));
    }
    // the page you are on changes as the square passes each marker
    var t = (y - rootTop) / (vh || 1), k = 0;
    for (var i = 1; i < C.length; i++) if (t >= C[i] - 0.01) k = i;
    if (k !== railK) {
      railK = k;
      stops.forEach(function (b, j) {
        if (j === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
        b.classList.toggle('is-past', j < k);
      });
      sayPage(NAMES[k] || '');
    }
    // the chat is the one thing the tag must never cover: fold it if they meet
    var tuck = false;
    if (desk && deskInert === false && rTag) {
      var dr = desk.getBoundingClientRect();
      var tagW = rTag.offsetWidth, tagH = rTag.offsetHeight;
      var ty = trackTop + p * trackH, tr = rail.getBoundingClientRect().left - 2;
      tuck = tr - tagW < dr.right && ty + tagH / 2 > dr.top && ty - tagH / 2 < dr.bottom;
    }
    if (tuck !== railTuck) { railTuck = tuck; rail.classList.toggle('is-tucked', tuck); }
  }

  // drag the rail like a scrollbar: anywhere on it, straight to that point
  if (rail) {
    var dragging = false;
    var dragTo = function (cy) { jump(Math.round(c01((cy - trackTop) / trackH) * maxY)); };
    rail.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('.rail__stop')) return;
      dragging = true;
      rail.classList.add('is-drag');
      try { rail.setPointerCapture(e.pointerId); } catch (_) {}
      dragTo(e.clientY);
      e.preventDefault();
    });
    rail.addEventListener('pointermove', function (e) { if (dragging) dragTo(e.clientY); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) {
      rail.addEventListener(ev, function () { dragging = false; rail.classList.remove('is-drag'); });
    });
  }

  function arrive(y, fn) {
    var t0 = performance.now();
    (function check() {
      if (Math.abs(scrollY - y) < 3 || performance.now() - t0 > 2500) { fn(); return; }
      requestAnimationFrame(check);
    })();
  }
  function goTo(i, focus) {
    var maxY = doc.scrollHeight - vh;
    var y = i >= C.length - 1 ? maxY : Math.round(rootTop + C[i] * vh + (i ? vh * 0.02 : 0));
    if (reduce) jump(y); else scrollTo({ top: y, behavior: 'smooth' });
    if (focus && input && i >= C.length - 1) {
      arrive(y, function () { setInert(false); input.focus({ preventScroll: true }); });
    }
  }
  stops.forEach(function (b, i) {
    b.addEventListener('click', function (e) { goTo(i, e.detail === 0 || fine); });
  });

  // scroll-behavior: smooth is set on <html>, and 'auto' means "whatever the CSS
  // says", so a jump has to switch it off for the one call.
  function jump(y) {
    var prev = doc.style.scrollBehavior;
    doc.style.scrollBehavior = 'auto';
    scrollTo(0, y);
    doc.style.scrollBehavior = prev;
  }
  var skip = document.querySelector('.skip');
  if (skip) skip.addEventListener('click', function (e) {
    e.preventDefault();
    jump(doc.scrollHeight - innerHeight);
    setInert(false);
    if (input) input.focus({ preventScroll: true });
  });

  // ---- the desk stays out of the tab order until it can be seen ------------
  var deskWin = (desk && desk.getAttribute('data-sc-window') || '0.835 1 0.3 0').split(/\s+/).map(parseFloat);
  var deskInert = null;
  function setInert(v) {
    if (!desk || v === deskInert) return;
    deskInert = v;
    desk.inert = v;
    if (v && desk.contains(document.activeElement)) document.activeElement.blur();
  }
  function deskFrame(t) {        // the same window maths the engine runs, on the same raw scroll
    if (!desk) return;
    setInert(windowVis(t / total, [deskWin[0], deskWin[1], isNaN(deskWin[2]) ? 0.3 : deskWin[2],
                                   isNaN(deskWin[3]) ? 0.3 : deskWin[3]]) <= 0.5);
  }

  // ---- scrims: the same windows as the copy they sit under ------------------
  // (the engine's window maths, run on the same raw scroll so they never drift apart)
  var scrims = [].map.call(document.querySelectorAll('[data-scrim]'), function (el) {
    var spec = el.getAttribute('data-scrim').trim(), w;
    if (spec === 'hero') w = [0, 0.62 * W[0] / total, 0, 0.65];
    else {
      var n = spec.split(/\s+/).map(parseFloat);
      w = [n[0], n[1], isNaN(n[2]) ? 0.3 : n[2], isNaN(n[3]) ? 0.3 : n[3]];
    }
    return { el: el, w: w };
  });
  function windowVis(pr, w) {
    var span = Math.max(w[1] - w[0], 1e-3), inEnd = w[0] + span * w[2], outStart = w[1] - span * w[3];
    if (pr < w[0]) return 0;
    if (pr < inEnd) return smooth((pr - w[0]) / Math.max(inEnd - w[0], 1e-3));
    if (pr <= outStart) return 1;
    return smooth(1 - (pr - outStart) / Math.max(w[1] - outStart, 1e-3));
  }
  function scrimFrame(t) {
    var pr = t / total;
    for (var i = 0; i < scrims.length; i++) css(scrims[i].el, 'opacity', windowVis(pr, scrims[i].w).toFixed(3));
  }

  // ---- the loop -------------------------------------------------------------
  var ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  var tCur = -1, tRaw = 0, raf = 0, last = 0;

  function tick(now) {
    raf = 0;
    var dt = last ? Math.min(64, now - last) : 16.67;
    last = now;
    tRaw = clamp((scrollY - rootTop) / (vh || 1), 0, total);
    if (tCur < 0 || settled) tCur = tRaw;
    else {
      tCur += (tRaw - tCur) * (1 - Math.pow(1 - 0.16, dt / 16.67));
      if (Math.abs(tRaw - tCur) < 4e-4) tCur = tRaw;
    }
    var pk = 1 - Math.pow(1 - 0.08, dt / 16.67);
    ptr.x += (ptr.tx - ptr.x) * pk;
    ptr.y += (ptr.ty - ptr.y) * pk;
    var drifting = Math.abs(ptr.tx - ptr.x) > 1e-3 || Math.abs(ptr.ty - ptr.y) > 1e-3;

    heroFrame(tCur, ptr.x, ptr.y);
    nlmap.update(tCur);
    ruleFrame(tCur);
    deskFrame(tRaw);
    scrimFrame(tRaw);
    railFrame();

    if (tCur !== tRaw || (drifting && tCur < W[0])) raf = requestAnimationFrame(tick);
    else last = 0;
  }
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', layout);
  if (fine && !reduce) {
    addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      ptr.tx = (e.clientX / vw) * 2 - 1;
      ptr.ty = (e.clientY / vh) * 2 - 1;
      if (tCur < W[0]) kick();
    }, { passive: true });
    document.documentElement.addEventListener('mouseleave', function () { ptr.tx = 0; ptr.ty = 0; kick(); });
  }

  // ---- loading --------------------------------------------------------------
  // The layered planes replace the poster only once every one of them has
  // decoded. If one fails, the poster stays and the page still works.
  var layerImgs = [].slice.call(campus.querySelectorAll('.plane--layer img'));
  Promise.all(layerImgs.map(function (img) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise(function (res, rej) {
      img.addEventListener('load', res, { once: true });
      img.addEventListener('error', rej, { once: true });
    });
  })).then(function () {
    return Promise.all(layerImgs.map(function (img) { return img.decode ? img.decode().catch(function () {}) : null; }));
  }).then(function () {
    ready = true;
    campus.classList.add('is-ready');
    css(pPoster, 'transform', 'none');
    kick();
  }, function () { /* keep the poster */ });

  // "Hoi" rises from behind the skyline, letter by letter, and the dot of the i
  // drops in last and strikes like a neon tube.
  var said = false;
  function sayHoi() {
    if (said) return;
    said = true;
    layout();
    var letters = hoi.querySelectorAll('.l');
    if (settled) {
      [].forEach.call(letters, function (l) { l.classList.add('on'); });
      hoi.classList.add('is-lit');
      document.body.classList.add('hoi-said');
      return;
    }
    [].forEach.call(letters, function (l, i) {
      setTimeout(function () { l.classList.add('on'); }, 120 + i * 130);
    });
    setTimeout(function () { hoi.classList.add('is-lit'); }, 980);
    setTimeout(function () { document.body.classList.add('hoi-said'); }, 1500);
  }
  var posterImg = pPoster.querySelector('img');
  var posterReady = posterImg.complete ? Promise.resolve() : new Promise(function (res) {
    posterImg.addEventListener('load', res, { once: true });
    posterImg.addEventListener('error', res, { once: true });
  });
  var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all([posterReady, fontsReady]).then(function () { setTimeout(sayHoi, 120); });
  setTimeout(sayHoi, 1600);

  // The engine sizes the track once at mount. A resize after the fonts and the
  // window have settled makes it, and this file, measure again.
  function relayout() { dispatchEvent(new Event('resize')); }
  addEventListener('load', relayout);
  fontsReady.then(relayout);

  if (location.hash === '#ask') {
    requestAnimationFrame(function () { jump(doc.scrollHeight - innerHeight); });
  }

  setInert(true);
  layout();
})();
