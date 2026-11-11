/* 流金岁月 · 顶部流沙
   质感参照金粉实拍：纯颗粒、无拖尾射线、无射线光。
   做法：数万颗沙粒一次性烘焙为纹理（按颜色/透明度分桶批量绘制），
   再让纹理极慢下滑；纵向消失由 CSS 渐变遮罩完成，
   区域截止到「音乐背后的故事」(#about) 上沿。 */
(function () {
  'use strict';

  var canvas = document.getElementById('gold-sand');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    return;
  }

  var ctx = canvas.getContext('2d');
  var W = 0, H = 0;
  var tex = null;
  var rafId = 0, lastT = 0, scroll = 0, paused = false;

  var FALL = 8;   /* 下落速度 px/s，极慢 */

  var COLS = [
    [255, 214, 126],
    [255, 230, 172],
    [238, 186, 84],
    [255, 243, 212],
    [205, 154, 60],
    [248, 202, 108],
    [228, 172, 70]
  ];
  var LEVELS = 30;        /* 透明度分档，批量绘制用 */
  var STEP = 0.02;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /* ---------- 区域：顶部 → #about 上沿 ---------- */
  function measure() {
    var anchor = document.getElementById('about');
    var top = anchor
      ? anchor.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0)
      : Math.round(window.innerHeight * 1.2);

    H = Math.round(clamp(top, 420, 4600));
    W = canvas.clientWidth || window.innerWidth || 1280;

    canvas.style.height = H + 'px';
    canvas.width = W;
    canvas.height = H;
  }

  /* ---------- 流带 + 内部细分丝（模拟金粉束的编织感） ---------- */
  function makeBands() {
    var cfg = W < 760
      ? [{ cx: 0.26, w: 0.26, tilt: 0.05, sway: 0.05 },
         { cx: 0.66, w: 0.30, tilt: -0.04, sway: 0.055 }]
      : [{ cx: 0.16, w: 0.19, tilt: 0.062, sway: 0.052 },
         { cx: 0.50, w: 0.24, tilt: -0.034, sway: 0.062 },
         { cx: 0.84, w: 0.17, tilt: 0.050, sway: 0.046 }];

    return cfg.map(function (b) {
      var nf = 3 + ((Math.random() * 2) | 0);   /* 3-4 股 */
      var fils = [];
      for (var i = 0; i < nf; i++) {
        fils.push({
          o: (i / (nf - 1) - 0.5) * 2 + rnd(-0.16, 0.16),  /* -1..1 */
          tilt: b.tilt + rnd(-0.022, 0.022),
          sway: b.sway * rnd(0.5, 1.2),
          ph: Math.random() * Math.PI * 2,
          w: rnd(0.27, 0.43)                                 /* 占带宽比例 */
        });
      }
      return {
        cx: b.cx, w: b.w * W, tilt: b.tilt, sway: b.sway,
        ph: Math.random() * Math.PI * 2, fils: fils
      };
    });
  }

  function bandCenter(b, y) {
    var t = y / H;
    return (b.cx + b.tilt * t + Math.sin(t * 2.3 + b.ph) * b.sway) * W;
  }
  function bandHalf(b, y) {
    var t = y / H;
    return b.w * 0.5 * (0.62 + t * 1.0);
  }
  function filCenter(b, f, y) {
    var t = y / H;
    var bar = (b.cx + f.tilt * t + Math.sin(t * 2.1 + f.ph) * f.sway) * W;
    return bar + f.o * bandHalf(b, y) * 0.72;
  }
  function filHalf(b, f, y) {
    return bandHalf(b, y) * f.w;
  }

  /* ---------- 烘焙纹理 ---------- */
  function buildTexture() {
    var bands = makeBands();

    tex = document.createElement('canvas');
    tex.width = W;
    tex.height = H;
    var g = tex.getContext('2d');
    g.clearRect(0, 0, W, H);

    /* 1. 极淡粉尘云，给流带体积感 */
    bands.forEach(function (b) {
      var puffs = Math.round(H / 150);
      for (var i = 0; i < puffs; i++) {
        var y = (i + Math.random()) / puffs * H;
        var cx = bandCenter(b, y) + rnd(-0.5, 0.5) * bandHalf(b, y);
        var rr = bandHalf(b, y) * rnd(1.2, 2.6);
        var gr = g.createRadialGradient(cx, y, 0, cx, y, rr);
        gr.addColorStop(0, 'rgba(230,180,86,' + rnd(0.006, 0.016).toFixed(3) + ')');
        gr.addColorStop(0.6, 'rgba(206,150,54,' + rnd(0.002, 0.006).toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(180,130,40,0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(cx, y, rr, 0, 6.2832);
        g.fill();
      }
    });

    /* 2. 主体沙粒：按 颜色×透明度 分桶，批量填充 */
    var buckets = [];
    for (var ci = 0; ci < COLS.length; ci++) {
      var row = new Array(LEVELS);
      for (var li = 0; li < LEVELS; li++) row[li] = [];
      buckets.push(row);
    }

    function drop(x, y, r, colIdx, a) {
      var q = clamp(Math.round(a / STEP), 1, LEVELS - 1);
      buckets[colIdx][q].push(x, y, r);
    }

    bands.forEach(function (b) {
      var area = 0;
      for (var s = 0; s < 24; s++) area += 2 * bandHalf(b, (s + 0.5) / 24 * H) * (H / 24);
      var n = Math.round(area / 16);

      for (var i = 0; i < n; i++) {
        var y = Math.random() * H;
        var f = b.fils[(Math.random() * b.fils.length) | 0];

        var loose = Math.random() < 0.13;
        var off = (Math.random() < 0.5 ? -1 : 1) * Math.pow(Math.random(), 1.7);
        if (loose) off *= rnd(1.3, 2.4);

        var x = filCenter(b, f, y) + off * filHalf(b, f, y);

        /* 簇状疏密：让沙流有厚薄起伏，避免均匀噪点 */
        var clump = 0.55
          + 0.42 * Math.sin(y * 0.0125 + f.ph)
          + 0.30 * Math.sin(x * 0.019 + f.ph * 1.7)
          + 0.18 * Math.sin(y * 0.0031 + 2.1);
        clump = clamp(clump, 0.18, 1.55);

        var s2 = Math.random();
        var r = s2 > 0.982 ? rnd(1.35, 1.9)
              : s2 > 0.86 ? rnd(0.9, 1.3)
              : s2 > 0.5 ? rnd(0.6, 0.9)
              : rnd(0.32, 0.58);

        var a = (r > 1.25 ? rnd(0.34, 0.66)
              : r > 0.85 ? rnd(0.22, 0.46)
              : rnd(0.10, 0.30)) * clump;
        if (loose) a *= 0.6;

        drop(x, y, r, (Math.random() * COLS.length) | 0, a);
      }
    });

    /* 3. 全宽散沙：打破三条"干净竖线"的机械感 */
    var dust = W < 760 ? 1800 : 4000;
    for (var d = 0; d < dust; d++) {
      var band = bands[(Math.random() * bands.length) | 0];
      var yy = Math.random() * H;
      var spread = bandHalf(band, yy) * rnd(1.4, 4.2);
      var xx = bandCenter(band, yy) + (Math.random() - 0.5) * 2 * spread;
      drop(xx, yy, rnd(0.28, 0.62), (Math.random() * COLS.length) | 0, rnd(0.03, 0.10));
    }

    /* 4. 零星高光，制造闪烁层次 */
    for (var k = 0; k < (W < 760 ? 1500 : 3800); k++) {
      var b2 = bands[(Math.random() * bands.length) | 0];
      var y2 = Math.random() * H;
      var x2 = bandCenter(b2, y2) + (Math.random() - 0.5) * 2 * bandHalf(b2, y2) * 1.15;
      drop(x2, y2, rnd(0.65, 1.2), 3, rnd(0.22, 0.52));
    }

    /* 统一绘制 */
    for (var c2 = 0; c2 < COLS.length; c2++) {
      for (var l = 1; l < LEVELS; l++) {
        var arr = buckets[c2][l];
        if (!arr.length) continue;
        var col = COLS[c2];
        g.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (l * STEP).toFixed(3) + ')';
        for (var p = 0; p < arr.length; p += 3) {
          var rr = arr[p + 2];
          g.fillRect(arr[p], arr[p + 1], rr * 1.25, rr * 1.6);
        }
      }
    }
  }

  /* ---------- 绘制：只重绘可视窗口，纹理循环缓慢下滑 ---------- */
  var lastTop = -1, lastBot = -1;

  function blit(ys, vTop, vBot) {
    var sTop = Math.max(ys, vTop);
    var sBot = Math.min(ys + H, vBot);
    if (sBot <= sTop) return;
    ctx.drawImage(tex, 0, sTop - ys, W, sBot - sTop, 0, sTop, W, sBot - sTop);
  }

  function draw() {
    if (!tex) return;

    var vTop = Math.max(0, Math.floor(window.pageYOffset - 80));
    var vBot = Math.min(H, Math.ceil(window.pageYOffset + window.innerHeight + 80));

    /* 清掉上一帧的绘制区（含滚动位移），避免残影 */
    var cTop = lastTop < 0 ? vTop : Math.min(lastTop, vTop);
    var cBot = lastBot < 0 ? vBot : Math.max(lastBot, vBot);
    ctx.clearRect(0, cTop, W, cBot - cTop);
    lastTop = vTop; lastBot = vBot;

    var off = scroll % H;
    blit(off, vTop, vBot);
    blit(off - H, vTop, vBot);
  }

  function inView() {
    return window.pageYOffset < H + 120;
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (paused || !inView()) { lastT = now; return; }
    var dt = lastT ? (now - lastT) / 1000 : 0.016;
    lastT = now;
    if (dt > 0.08) dt = 0.08;
    scroll += FALL * dt;
    if (scroll >= H) scroll -= H;
    draw();
  }

  function start() {
    measure();
    buildTexture();
    scroll = 0;
    lastT = 0;
    draw();
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  var rt = 0;
  function onResize() {
    clearTimeout(rt);
    rt = setTimeout(function () {
      measure();
      buildTexture();
      scroll = 0;
      lastT = 0;
      lastTop = -1; lastBot = -1;
      draw();
    }, 280);
  }

  document.addEventListener('visibilitychange', function () {
    paused = document.hidden;
    lastT = 0;
  });
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  window.addEventListener('load', function () {
    if (!tex) return;
    measure();
    buildTexture();
    scroll = 0;
    lastT = 0;
    draw();
  }, { once: true });
})();
