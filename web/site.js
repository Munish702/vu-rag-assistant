/* site.js - this page's own choreography.
   The engine (scrollcraft.js) owns the scroll track, the leg opacities and the
   copy windows. This file owns what happens inside them: the layered campus and
   its push-in, the rulebook rush and collapse, the map in the bar, and keeping
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
  var stops = [].slice.call(document.querySelectorAll('.map__stop'));
  var mapList = document.querySelector('.map ol');

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
  // Measured on the plates (see src-plates/make_plates.py): where the roof line
  // runs and where the lamp stands, in plate pixels, plus the object-position
  // each plate is shown at. Everything below is mapped through object-fit: cover.
  var PLATES = {
    d: { w: 2400, h: 1500, px: 0.5, py: 0.38, roofL: [0, 547], roofR: [1177, 497], lamp: [1120, 1168] },
    m: { w: 1080, h: 1672, px: 0.46, py: 0.5, roofL: [0, 676], roofR: [706, 646], lamp: [672, 1049] }
  };
  var vw = 0, vh = 0, rootTop = 0, barH = 76, qTopY = 0, cardFinalY = 0, mapDots = null;

  function capRatio() {
    try {
      var cs = getComputedStyle(hoi);
      var g = capRatio.g || (capRatio.g = document.createElement('canvas').getContext('2d'));
      g.font = cs.fontWeight + ' 100px ' + cs.fontFamily;
      if ('fontStretch' in g) g.fontStretch = 'expanded';
      var a = g.measureText('H').actualBoundingBoxAscent;
      if (a > 40 && a < 95) return a / 100;
    } catch (e) { /* fall through */ }
    return 0.72;
  }

  // "Hoi" fills the sky over the building and sits ON the roof: its baseline is
  // seated a little below the roof line, so the building hides the foot of
  // every letter and is already in front of the word before anything moves.
  function layoutHero() {
    var pl = phone.matches ? PLATES.m : PLATES.d;
    var s = Math.max(vw / pl.w, vh / pl.h);
    var ox = (vw - pl.w * s) * pl.px, oy = (vh - pl.h * s) * pl.py;
    function at(p) { return [ox + p[0] * s, oy + p[1] * s]; }
    var rl = at(pl.roofL), rr = at(pl.roofR), lamp = at(pl.lamp);
    cssVar(doc, '--lamp-x', (lamp[0] / vw * 100).toFixed(2) + '%');
    cssVar(doc, '--lamp-y', (lamp[1] / vh * 100).toFixed(2) + '%');

    hoi.style.setProperty('--hoi-size', '100px');          // measure in the face that actually loaded
    var w100 = hoiWord.offsetWidth || 170;
    var b100 = hoiBase.offsetTop || 70;                       // baseline, from the top of the line box
    var cap100 = capRatio() * 100;
    var left = parseFloat(getComputedStyle(hoi).left) || 20;
    function roofAt(x) { return rl[1] + (rr[1] - rl[1]) * ((x - rl[0]) / ((rr[0] - rl[0]) || 1)); }

    var fsW = Math.max(120, (rr[0] - left) * 0.95) / w100 * 100;   // stay over the building
    var fs = fsW;
    for (var i = 0; i < 3; i++) {                                   // and clear the bar
      var roof = roofAt(left + w100 * fs / 200);
      fs = Math.min(fsW, (roof - barH - vh * 0.035) / (0.88 * cap100 / 100), vh * 0.45);
    }
    fs = Math.max(56, fs);
    var roofMid = roofAt(left + w100 * fs / 200);
    var baseline = roofMid + cap100 * fs / 100 * 0.12;
    hoi.style.setProperty('--hoi-size', fs.toFixed(1) + 'px');
    hoi.style.setProperty('--hoi-top', (baseline - b100 * fs / 100).toFixed(1) + 'px');
  }

  function layoutMap() {
    if (!mapList || !stops.length) return;
    var box = mapList.getBoundingClientRect();
    mapDots = stops.map(function (b) {
      var r = b.querySelector('.map__dot').getBoundingClientRect();
      return r.left + r.width / 2 - box.left;
    });
    cssVar(mapList, '--line-l', mapDots[0].toFixed(1) + 'px');
    cssVar(mapList, '--line-r', (box.width - mapDots[mapDots.length - 1]).toFixed(1) + 'px');
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
    layoutMap();
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
    css(pLamp, 'transform', T(-mx * 26, 0.08 * vh * e0 - my * 16, 1 + 0.35 * e0));
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

  // ---- the map: a lit line that grows from stop to stop --------------------
  function mapFrame(t) {
    if (!mapDots) return;
    var k = 0;
    for (var i = 0; i < C.length; i++) if (t >= C[i] - 1e-3) k = i;
    var d0 = mapDots[0], dN = mapDots[mapDots.length - 1];
    var x = k >= mapDots.length - 1 ? dN : lerp(mapDots[k], mapDots[k + 1], c01((t - C[k]) / W[k]));
    cssVar(mapList, '--map-p', ((x - d0) / ((dN - d0) || 1)).toFixed(4));
  }

  root.addEventListener('sc:waypoint', function (e) {
    var k = e.detail ? e.detail.index : 0;
    stops.forEach(function (b, i) {
      if (i === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    layoutMap();          // on a phone only the current stop shows its label, so the dots move
    kick();
  });

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
    ruleFrame(tCur);
    mapFrame(tCur);
    deskFrame(tRaw);
    scrimFrame(tRaw);

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

  // "Hoi" types itself once the photograph and the face are both there.
  var said = false;
  function sayHoi() {
    if (said) return;
    said = true;
    layout();
    var letters = hoi.querySelectorAll('.l');
    if (settled) {
      [].forEach.call(letters, function (l) { l.classList.add('on'); });
      hoi.classList.add('is-done');
      document.body.classList.add('hoi-said');
      return;
    }
    [350, 600, 850].forEach(function (ms, i) {
      setTimeout(function () { if (letters[i]) letters[i].classList.add('on'); }, ms);
    });
    setTimeout(function () { document.body.classList.add('hoi-said'); }, 1250);
    setTimeout(function () { hoi.classList.add('is-done'); }, 2800);
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
