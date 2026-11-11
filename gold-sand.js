/* 流金岁月 · 背景流沙粒子（若隐若现，纯装饰，不拦截任何交互） */
(function () {
  var cv = document.getElementById('gold-sand');
  if (!cv || !cv.getContext) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cv.parentNode && cv.parentNode.removeChild(cv);
    return;
  }

  var ctx = cv.getContext('2d', { alpha: true });
  var W = 0, H = 0, dpr = 1;
  var bands = [], grains = [], motes = [], dust = [];
  var last = 0, raf = 0, running = true;

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function buildBands() {
    var n = W < 760 ? 4 : 6;
    bands = [];
    for (var i = 0; i < n; i++) {
      bands.push({
        cx: (i + 0.5) / n * W + rnd(-0.05, 0.05) * W,
        amp: rnd(30, Math.min(95, W * 0.065)),  // 摆动幅度
        freq: rnd(0.45, 0.95),                   // 曲线频率
        phase: rnd(0, Math.PI * 2),
        halfW: rnd(26, W < 760 ? 46 : 72),       // 沙流宽度（更收束）
        alpha: rnd(0.5, 1)                       // 该流带的整体浓度系数
      });
    }
  }

  function buildGrains() {
    var area = W * H;
    var count = Math.round(area / (W < 760 ? 6200 : 3600));
    count = Math.max(120, Math.min(count, 560));
    grains = [];
    for (var i = 0; i < count; i++) {
      var b = bands[(Math.random() * bands.length) | 0];
      var speed = rnd(38, 118);                   // px/s，慢速流动
      var sign = Math.random() < 0.5 ? -1 : 1;
      var off = sign * Math.pow(Math.random(), 1.9) * b.halfW; // 向中心聚拢
      grains.push({
        b: b,
        y: rnd(-H * 0.25, H),
        off: off,
        speed: speed,
        len: speed * rnd(0.55, 1.30),             // 拖尾长度（连续流线）
        w: rnd(0.7, 1.8),
        a: rnd(0.12, 0.52) * b.alpha,             // 单粒浓度
        seed: rnd(0, 1000)
      });
    }

    var dCount = Math.max(70, Math.min(Math.round(area / 7000), 260));
    dust = [];
    for (var d = 0; d < dCount; d++) {
      var bd2 = bands[(Math.random() * bands.length) | 0];
      dust.push({
        b: bd2,
        y: rnd(-H * 0.2, H),
        off: rnd(-1.6, 1.6) * bd2.halfW,
        speed: rnd(45, 150),
        r: rnd(0.5, 1.15),
        a: rnd(0.06, 0.22),
        seed: rnd(0, 999)
      });
    }

    var mCount = Math.max(8, Math.round(area / 70000));
    motes = [];
    for (var j = 0; j < mCount; j++) {
      motes.push({
        x: rnd(0, W),
        y: rnd(0, H),
        r: rnd(1.6, 4.2),
        vy: rnd(6, 20),
        vx: rnd(-3, 3),
        a: rnd(0.02, 0.055),
        ph: rnd(0, Math.PI * 2)
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth || window.innerWidth;
    H = cv.clientHeight || window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildBands();
    buildGrains();
  }

  function xAt(g, y, ts) {
    var t = (y / H) * Math.PI * 1.7 * g.b.freq + g.b.phase;
    var sway = Math.sin(ts / 900 + g.seed) * 1.4;
    return g.b.cx + Math.sin(t) * g.b.amp + g.off * 0.42 + sway;
  }

  function edgeFade(y) {
    var top = y / (H * 0.20);
    var bot = (H - y) / (H * 0.14);
    return Math.max(0, Math.min(1, Math.min(top, bot)));
  }

  function frame(ts) {
    if (!running) return;
    if (!last) last = ts;
    var dt = Math.min((ts - last) / 1000, 0.05);
    last = ts;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    // 沙帘：每条流带一层极淡的竖向辉光，让「瀑布」有形
    for (var k = 0; k < bands.length; k++) {
      var bd = bands[k];
      var w2 = bd.halfW * 1.7;
      var gx = ctx.createLinearGradient(bd.cx - w2, 0, bd.cx + w2, 0);
      gx.addColorStop(0, 'rgba(255,190,110,0)');
      gx.addColorStop(0.5, 'rgba(255,196,120,' + (0.05 * bd.alpha) + ')');
      gx.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = gx;
      ctx.fillRect(bd.cx - w2, 0, w2 * 2, H);
    }

    // 大颗柔光尘（营造景深）
    for (var m = 0; m < motes.length; m++) {
      var mo = motes[m];
      mo.y += mo.vy * dt;
      mo.x += mo.vx * dt;
      if (mo.y - mo.r > H) { mo.y = -mo.r * 2; mo.x = rnd(0, W); }
      if (mo.x < -10) mo.x = W + 10;
      if (mo.x > W + 10) mo.x = -10;
      var tw = 0.65 + 0.35 * Math.sin(ts / 1400 + mo.ph);
      var g = ctx.createRadialGradient(mo.x, mo.y, 0, mo.x, mo.y, mo.r * 3.2);
      g.addColorStop(0, 'rgba(255,206,128,' + (mo.a * tw * edgeFade(mo.y)) + ')');
      g.addColorStop(1, 'rgba(255,170,70,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(mo.x, mo.y, mo.r * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 细沙流（短拖尾线段）
    for (var i = 0; i < grains.length; i++) {
      var s = grains[i];
      s.y += s.speed * dt;
      if (s.y - s.len > H + 20) {
        s.y = rnd(-80, -10);
        s.off = rnd(-1, 1) * s.b.halfW;
      }
      var a = s.a * edgeFade(s.y) * (1 - 0.3 * (s.y / H));
      if (a <= 0.004) continue;
      var yTail = s.y - s.len;
      var xHead = xAt(s, s.y, ts);
      var xTail = xAt(s, yTail, ts);
      var gcol = 205 + ((s.seed * 7) % 30 | 0);
      // 拖尾（沿流带曲线走向，不是竖直直线）
      ctx.strokeStyle = 'rgba(255,' + gcol + ',132,' + (a * 0.75) + ')';
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(xTail, yTail);
      ctx.lineTo(xHead, s.y);
      ctx.stroke();
      // 密度高处的柔光晕，让流金有「体积」
      if (a > 0.22) {
        ctx.strokeStyle = 'rgba(255,' + (gcol - 20) + ',110,' + (a * 0.16) + ')';
        ctx.lineWidth = s.w * 4;
        ctx.beginPath();
        ctx.moveTo(xTail, yTail);
        ctx.lineTo(xHead, s.y);
        ctx.stroke();
      }
      // 沙粒头部亮点，读起来像金砂而非雨丝
      ctx.fillStyle = 'rgba(255,' + (gcol + 22) + ',158,' + a + ')';
      ctx.beginPath();
      ctx.arc(xHead, s.y, s.w * 1.25, 0, Math.PI * 2);
      ctx.fill();
    }

    // 细沙：极小的金色尘点，补足「沙」的颗粒感
    for (var q = 0; q < dust.length; q++) {
      var du = dust[q];
      du.y += du.speed * dt;
      if (du.y > H + 10) { du.y = rnd(-60, -5); du.off = rnd(-1.6, 1.6) * du.b.halfW; }
      var dx = xAt(du, du.y, ts);
      var da = du.a * edgeFade(du.y);
      if (da <= 0.004) continue;
      ctx.fillStyle = 'rgba(255,' + (215 + ((du.seed * 5) % 35 | 0)) + ',165,' + da + ')';
      ctx.beginPath();
      ctx.arc(dx, du.y, du.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  var rt = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(resize, 180);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  resize();
  start();
})();
