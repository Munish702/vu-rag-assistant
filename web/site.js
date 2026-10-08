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
      if (op < 0.004) { css(f.el, 'opacity', '0'); css(f.el, 'visibility', 'hidden'); continue; }
      css(f.el, 'visibility', 'visible');
      css(f.el, 'opacity', op.toFixed(3));
      css(f.el, 'transform', placed(f.x * vw * sc, f.y * vh * sc, sc));
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

  // ---- the Netherlands ---------------------------------------------------------
  // Behind the rulebook, the country as a grid of tiny squares. As the reader
  // scrolls, squares light up in a wave that starts at the VU in Amsterdam and
  // spreads across the whole country, in step with the scroll. Outline drawn by
  // hand from the coastline (lon, lat): mainland, Zeeuws-Vlaanderen, the Wadden
  // islands, with the IJsselmeer and Markermeer cut out as water.
  var nlmap = (function () {
    var cv = campus.querySelector('.plane--map');
    if (!cv || !cv.getContext) return { layout: function () {}, update: function () {} };
    var g = cv.getContext('2d');
    var LAND = [
      [[3.45,51.52],[3.52,51.59],[3.70,51.58],[4.00,51.56],[4.15,51.60],[3.95,51.64],[3.70,51.68],[3.80,51.74],[4.00,51.72],[4.10,51.75],[3.90,51.80],[3.85,51.83],[4.05,51.86],[4.12,51.98],[4.27,52.10],[4.42,52.25],[4.56,52.46],[4.62,52.62],[4.66,52.77],[4.72,52.93],[4.78,52.96],[5.04,52.94],[5.20,53.02],[5.39,53.08],[5.41,53.17],[5.55,53.27],[5.90,53.38],[6.20,53.41],[6.45,53.43],[6.70,53.46],[6.85,53.44],[6.93,53.33],[7.05,53.30],[7.20,53.24],[7.21,53.18],[7.07,53.00],[7.05,52.85],[7.07,52.64],[6.75,52.64],[6.70,52.49],[7.03,52.40],[7.06,52.23],[6.83,52.11],[6.69,52.03],[6.83,51.97],[6.40,51.84],[6.17,51.85],[5.95,51.81],[5.97,51.73],[6.21,51.51],[6.07,51.20],[5.90,51.05],[6.08,50.92],[6.02,50.76],[5.70,50.76],[5.64,50.85],[5.77,51.03],[5.85,51.15],[5.53,51.27],[5.24,51.26],[5.08,51.47],[4.85,51.46],[4.75,51.50],[4.55,51.43],[4.40,51.36],[4.24,51.37],[4.05,51.42],[3.80,51.44],[3.60,51.44]],
      [[3.37,51.37],[3.55,51.41],[3.75,51.35],[3.95,51.40],[4.20,51.36],[4.24,51.33],[3.95,51.21],[3.70,51.23],[3.50,51.25]],
      [[4.70,53.00],[4.75,52.99],[4.90,53.08],[4.88,53.18],[4.83,53.18],[4.72,53.10]],
      [[4.92,53.23],[5.10,53.30],[5.12,53.28],[4.96,53.22]],
      [[5.18,53.36],[5.30,53.39],[5.55,53.45],[5.60,53.44],[5.40,53.38],[5.20,53.35]],
      [[5.62,53.44],[5.75,53.47],[5.92,53.46],[5.92,53.43],[5.70,53.43]],
      [[6.10,53.48],[6.25,53.50],[6.33,53.49],[6.25,53.46],[6.12,53.46]]
    ];
    var WATER = [[[5.04,52.94],[5.20,53.00],[5.39,53.05],[5.40,52.99],[5.36,52.88],[5.47,52.85],[5.62,52.80],[5.60,52.68],[5.50,52.60],[5.43,52.53],[5.30,52.47],[5.17,52.38],[5.04,52.38],[5.00,52.43],[5.07,52.52],[5.05,52.62],[5.10,52.66],[5.25,52.70],[5.25,52.74],[5.12,52.77],[5.06,52.84]]];
    var ORIGIN = [4.865, 52.334];                     // VU Amsterdam
    var CITIES = [[4.90, 52.37], [4.48, 51.92], [4.30, 52.08], [5.12, 52.09], [5.47, 51.44],
                  [6.57, 53.22], [5.91, 51.98], [5.85, 51.84], [5.69, 50.85], [6.89, 52.22], [4.64, 52.39]];
    var LON0 = 3.3, LON1 = 7.3, LAT0 = 50.7, LAT1 = 53.56, K = Math.cos(52.2 * Math.PI / 180);
    var ASPECT = ((LON1 - LON0) * K) / (LAT1 - LAT0);

    function inside(x, y, ring) {
      var hit = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    }
    function isLand(lon, lat) {
      for (var w = 0; w < WATER.length; w++) if (inside(lon, lat, WATER[w])) return false;
      for (var l = 0; l < LAND.length; l++) if (inside(lon, lat, LAND[l])) return true;
      return false;
    }
    var seed = 52;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

    var cells = [], sea = [], box = null, pitch = 7, sq = 2.4, dpr = 1, tNow = -1, raf = 0, W0 = 0;

    function layoutMap() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
      W0 = vw;
      // the country fills most of the height on a desktop, most of the width on a phone
      var mh = phone.matches ? Math.min(vh * 0.62, (vw * 0.94) / ASPECT) : vh * 0.84;
      var mw = mh * ASPECT;
      box = { x: (vw - mw) / 2, y: (vh - mh) / 2 + vh * 0.03, w: mw, h: mh };
      pitch = Math.max(4.5, mh / 112);
      sq = Math.max(1.5, pitch * 0.36);
      cells = []; sea = []; seed = 52;
      var cols = Math.floor(mw / pitch), rows = Math.floor(mh / pitch);
      var maxD = 0;
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var lon = LON0 + (c + 0.5) / cols * (LON1 - LON0);
          var lat = LAT1 - (r + 0.5) / rows * (LAT1 - LAT0);
          var x = box.x + (c + 0.5) * pitch, y = box.y + (r + 0.5) * pitch;
          var n = rnd();
          if (!isLand(lon, lat)) { if (n < 0.16) sea.push({ x: x, y: y }); continue; }
          var d = Math.hypot((lon - ORIGIN[0]) * K, lat - ORIGIN[1]);
          var city = 0;
          for (var k = 0; k < CITIES.length; k++) {
            var dc = Math.hypot((lon - CITIES[k][0]) * K, lat - CITIES[k][1]);
            if (dc < 0.07) city = Math.max(city, 1 - dc / 0.07);
          }
          maxD = Math.max(maxD, d);
          cells.push({ x: x, y: y, d: d, n: n, city: city, ph: rnd() * 6.283 });
        }
      }
      // when each square lights: mostly by distance from the VU, a little at random
      cells.forEach(function (cl) { cl.at = 0.82 * (cl.d / maxD) + 0.16 * cl.n; });
      draw(performance.now());
    }

    function bump(x) { return x > 0 && x < 1.6 ? Math.sin(x / 1.6 * Math.PI) : 0; }

    function draw(now) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      if (tNow < 0 || !box) return 0;
      var q = (tNow - C[1]) / W[1];
      var level = smooth((q + 0.03) / 0.06)                     // appears as the rulebook begins
                * (1 - 0.5 * ramp(q, 0.62, 0.7))                 // the hush belongs to one light
                * (1 - 0.3 * ramp(q, 0.7, 0.9));                 // quiet behind the answer and the desk
      if (level < 0.005) return 0;
      var wave = c01((q - 0.0) / 0.58) * 1.1;                   // the whole country lit by the end of the rush
      var time = settled ? 0 : now / 1000;
      var grow = reduce ? 1 : 1 + 0.05 * smooth((q - 0.2) / 0.5);
      var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      g.setTransform(dpr * grow, 0, 0, dpr * grow, dpr * cx * (1 - grow), dpr * cy * (1 - grow));
      var h = sq / 2, i, cl;

      // the sea and the unlit country: a faint digital grid
      g.fillStyle = 'rgba(127,184,240,' + (0.06 * level).toFixed(3) + ')';
      for (i = 0; i < sea.length; i++) g.fillRect(sea[i].x - h * 0.7, sea[i].y - h * 0.7, sq * 0.7, sq * 0.7);
      g.fillStyle = 'rgba(127,184,240,' + (0.28 * level).toFixed(3) + ')';
      for (i = 0; i < cells.length; i++) { cl = cells[i]; g.fillRect(cl.x - h, cl.y - h, sq, sq); }

      // the lit squares
      g.globalCompositeOperation = 'lighter';
      for (i = 0; i < cells.length; i++) {
        cl = cells[i];
        var x = (wave - cl.at) / 0.03;
        if (x <= 0) continue;
        var on = smooth(x), flare = bump(x);
        var flick = reduce ? 1 : 0.8 + 0.2 * Math.sin(time * (1.3 + cl.n * 2.4) + cl.ph);
        var a = level * on * flick * (0.55 + 0.45 * Math.max(cl.city, cl.n * 0.7));
        var s = sq * (1 + 0.9 * flare + 0.5 * cl.city);
        if (flare > 0.02 || cl.city > 0.3) {            // a soft square halo while it catches, and on the cities
          g.fillStyle = 'rgba(127,184,240,' + (0.22 * level * Math.max(flare, cl.city * 0.6)).toFixed(3) + ')';
          g.fillRect(cl.x - s * 1.6, cl.y - s * 1.6, s * 3.2, s * 3.2);
        }
        g.fillStyle = cl.city > 0.5 || flare > 0.5 ? 'rgba(225,240,255,' + Math.min(1, a).toFixed(3) + ')'
                                                    : 'rgba(127,184,240,' + Math.min(1, a).toFixed(3) + ')';
        g.fillRect(cl.x - s / 2, cl.y - s / 2, s, s);
      }
      g.globalCompositeOperation = 'source-over';
      return level;
    }

    function loop(now) {
      raf = 0;
      var level = draw(now);
      if (level > 0.005 && !settled) raf = requestAnimationFrame(loop);
    }

    return {
      layout: layoutMap,
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
