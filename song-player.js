'use strict';
/* ============================================================
 * 后摇日历 · 翻页即播放（Day-Song Player）
 * ------------------------------------------------------------
 * 设计要点：
 *  1) 页面本身只存 music.163.com/#/song?id=xxx 的跳转链接，
 *     官方接口匿名只放行约 14%（51/365），所以必须走解析层拿直链。
 *  2) 解析结果带签名与时效，不能进静态 JSON，只能运行期拿 + 短缓存。
 *  3) 翻页是用户手势，play() 必须在手势上下文内同步发起，
 *     因此采用「预取邻居 → 手势内直接 play()」策略，做到无延迟。
 *  4) 四级兜底：三条解析通道（gdstudio 优先）→ 同曲合作版 → QQ 60s 试听 → 跳转提示。
 * ============================================================ */
(function () {
  /* ============================================================
   * 上游解析通道表（按优先级排列，gdstudio 优先）
   * ------------------------------------------------------------
   * kind=json     : 返回 JSON {url,br,size}，直接拿 url
   * kind=redirect : 302 跳到 mp3，把通道地址本身当 <audio src>
   * 全部实测带 Access-Control-Allow-Origin: *，页面直连即可。
   * 任何一条挂了会被熔断 5 分钟，让位给下一条。
   * ============================================================ */
  const CHANNELS = [
    {
      name: 'gdstudio',
      kind: 'json',
      url: (id) => `https://music-api.gdstudio.xyz/api.php?types=url&source=netease&br=320&id=${id}`,
      timeout: 9000,
    },
    {
      name: 'injahow',
      kind: 'redirect',
      url: (id) => `https://api.injahow.cn/meting/?type=url&id=${id}`,
      timeout: 7000,
    },
    {
      name: 'qijieya',
      kind: 'redirect',
      url: (id) => `https://api.qijieya.cn/meting/?type=url&id=${id}`,
      timeout: 7000,
    },
  ];
  const BREAKER_THRESHOLD = 3;              // 连续失败 3 次熔断
  const BREAKER_COOLDOWN = 5 * 60 * 1000;   // 熔断 5 分钟

  const CACHE_KEY = 'prc2026.urlcache.v1';
  const CACHE_TTL = 8 * 60 * 1000;          // 网易云签名直链实测存活 ≥20min，这里保守取 8min
  const PRELOAD_RADIUS = 1;                 // 预取前后各 1 天（再多会打爆上游并发）
  /* 网易云已下架/无直链的曲目 → 用同曲可播版本兜底（键：原 songId） */
  const ALT_IDS = {
    '382218': { id: '27588545', note: '原版已下架 · 播放合作版' },
    '382173': null,                          // 无网易云替代
    '382144': null,
  };

  /* 网易云彻底无源的曲目 → QQ 音乐 60s 试听兜底。
     实测：vkey 接口支持 JSONP（无需 CORS），RS02 档试听 128k/约 60s，
     音频 CDN 带 Access-Control-Allow-Origin: *，可直接喂给 <audio>。
     整曲（M500/C400/F000）全部 104003 无权限，只有试听档可用。 */
  const QQ_TRIALS = {
    '382173': { mid: '0028w8qh33PEbF', mmid: '001OlVEE1ctkNR', dur: 586 },
    '382144': { mid: '002UuNEX3TgnEb', mmid: '001Eil8Y0Uty5B', dur: 361 },
    '382218': { mid: '004NgTyP3H2lUw', mmid: '003ZQIMV1yy9uh', dur: 293 },
  };
  const QQ_VKEY = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=jsonp&data=';

  const state = {
    index: -1,
    day: null,
    src: null,          // 可直接喂给 <audio> 的地址
    via: null,          // 'gdstudio' | 'injahow' | 'qijieya' | 'qq-trial' | 'none'
    autoplay: true,
    bgmWasPlaying: false,
    userInteracted: false,
    busy: false,
    altNote: '',
    trial: false,
    token: 0,
  };

  const cache = loadCache();
  const preloads = new Map();               // key: songId -> {el, src}
  let audio = null, els = {}, pending = null;

  /* ---------------- 手势令牌 ---------------- */
  function markGesture() { state.userInteracted = true; }

  /* ---------------- 缓存 ---------------- */
  function loadCache() {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function saveCache() {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }
  function cacheGet(id) {
    const v = cache[id];
    if (!v) return null;
    if (Date.now() - v.t > CACHE_TTL) { delete cache[id]; return null; }
    return v;
  }
  function cachePut(id, src, via, extra) {
    cache[id] = { src, via, t: Date.now(), extra: extra || null };
    saveCache();
  }

  /* ---------------- 解析层 ---------------- */
  /* 上游接口对并发极敏感：连发多个会直接 TypeError（CORS/连接被掐）。
     这里做「双优先级串行队列」：current（当前页，优先） / lazy（预取，可丢）。 */
  const lanes = { current: [], lazy: [] };
  let pumping = false, lastAt = 0, generation = 0;
  const GAP = 240;

  function schedule(task, lane) {
    return new Promise((resolveP) => {
      const job = { task, resolveP, lane, gen: generation };
      (lanes[lane] || lanes.current).push(job);
      pump();
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (lanes.current.length || lanes.lazy.length) {
      const job = lanes.current.shift() || lanes.lazy.shift();
      const wait = Math.max(0, GAP - (Date.now() - lastAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (job.lane === 'lazy' && lanes.current.length) { job.resolveP(null); continue; }  // 让位给当前页
      if (job.gen !== generation && job.lane === 'current') { job.resolveP(null); continue; }  // 已被翻页作废
      try { job.resolveP(await job.task()); } catch (e) { job.resolveP(Promise.reject(e)); }
      lastAt = Date.now();
    }
    pumping = false;
  }

  /* ---------------- 通道熔断 ---------------- */
  const breaker = {};   // name -> { fails, until }
  function breakerOpen(name) {
    const b = breaker[name];
    if (!b) return false;
    if (b.until && Date.now() < b.until) return true;
    if (b.until && Date.now() >= b.until) { breaker[name] = undefined; return false; }
    return false;
  }
  function breakerFail(name) {
    const b = breaker[name] || { fails: 0, until: 0 };
    b.fails += 1;
    if (b.fails >= BREAKER_THRESHOLD) b.until = Date.now() + BREAKER_COOLDOWN;
    breaker[name] = b;
  }
  function breakerOk(name) { breaker[name] = undefined; }

  /* 单通道取流；成功返回 {src, via, extra}，失败抛错（message 区分类型）
     - json 型：解析 {url,br,size}
     - redirect 型：跟到 CDN，读响应头就掐断（不下载正文），
       按 content-type 判定：audio/* 有用，text/html 表示这首无源。
       优先用落地后的 CDN 直链（可 seek、可缓存），失败则退回通道地址自跳。 */
  async function tryChannel(ch, id, lane) {
    if (breakerOpen(ch.name)) throw new Error('breaker');
    const url = ch.url(id);

    if (ch.kind === 'json') {
      const r = await schedule(
        () => fetch(url, {
          mode: 'cors', redirect: 'follow', credentials: 'omit',
          signal: AbortSignal.timeout(ch.timeout),
        }),
        lane
      );
      if (!r) throw new Error('dropped');
      if (!r.ok) throw new Error('http ' + r.status);
      let j = null;
      try { j = await r.json(); } catch (e) { throw new Error('bad json'); }
      if (j && j.url) return { src: j.url, via: ch.name, extra: { br: j.br, size: j.size } };
      throw new Error('no-url');          // 通道活着，但这首没源
    }

    /* redirect 型：手动发一个只读响应头的探针 */
    const probe = await schedule(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ch.timeout);
      try {
        const r = await fetch(url, { mode: 'cors', redirect: 'follow', credentials: 'omit', signal: ac.signal });
        const info = {
          ct: (r.headers.get('content-type') || '').toLowerCase(),
          size: Number(r.headers.get('content-length') || 0),
          finalUrl: r.url || url,
        };
        ac.abort();                        // 拿到头就掐，绝不下载整首
        return info;
      } finally {
        clearTimeout(timer);
      }
    }, lane);
    if (!probe) throw new Error('dropped');

    if (/^audio\//.test(probe.ct)) {
      // 落地后的 CDN 直链优先；探针虽被 abort，签名直链本身仍可复用
      const src = /^https?:/.test(probe.finalUrl) ? probe.finalUrl : url;
      return { src, via: ch.name, extra: { size: probe.size } };
    }
    if (probe.ct.includes('text/html')) throw new Error('no-url');   // 空页 = 这首无源
    // content-type 不明（有些节点不回）→ 保守用通道地址自跳，交给 <audio> 判断
    if (!probe.ct) return { src: url, via: ch.name, extra: null };
    throw new Error('bad type');
  }

  /* 按优先级尝试全部通道 */
  async function resolve(id, lane) {
    lane = lane || 'current';
    const hit = cacheGet(id);
    if (hit) return hit;

    let sawNoUrl = false;    // 至少一条通道明确说「这首没源」
    let tried = 0;

    for (const ch of CHANNELS) {
      if (breakerOpen(ch.name)) continue;
      tried++;
      // 单通道内部重试：网络类错误重试 1 次，no-url 不重试
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await tryChannel(ch, id, lane);
          breakerOk(ch.name);
          cachePut(id, r.src, r.via, r.extra);
          return cacheGet(id);
        } catch (e) {
          const msg = String(e.message || '');
          if (msg === 'no-url') { breakerOk(ch.name); sawNoUrl = true; break; }  // 通道好，这首没源 → 换下一条
          if (msg === 'dropped') return null;                                     // 已翻页作废
          if (msg === 'breaker') break;
          if (attempt === 1) { breakerFail(ch.name); break; }                      // 两次都失败 → 记熔断 + 换通道
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (sawNoUrl) break;   // 通道明确表示这首无源（后端同源）→ 不必再试其余通道
    }

    // 全部失败 / 全部熔断 / 全部无源：一律不写缓存，下次翻回来重新尝试
    return null;
  }

  /* ---------------- QQ 音乐试听兜底（仅 60s） ---------------- */
  function jsonp(url, timeout) {
    return new Promise((resolveP, rejectP) => {
      const name = '__prc_qq_' + Math.random().toString(36).slice(2);
      const s = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); rejectP(new Error('jsonp timeout')); }, timeout || 8000);
      function cleanup() { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); }
      window[name] = (data) => { cleanup(); resolveP(data); };
      s.onerror = () => { cleanup(); rejectP(new Error('jsonp error')); };
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + name;
      document.head.appendChild(s);
    });
  }

  async function resolveQQTrial(songId, lane) {
    const t = QQ_TRIALS[songId];
    if (!t) return null;
    const key = 'qq:' + songId;
    const hit = cacheGet(key);
    if (hit) return hit;

    try {
      const filename = 'RS02' + t.mmid + '.mp3';
      const payload = {
        req_0: {
          module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
          param: {
            guid: '10000', songmid: [t.mid], songtype: [0], uin: '0',
            loginflag: 1, platform: '20', filename: [filename],
          },
        },
        comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
      };
      const j = await schedule(
        () => jsonp(QQ_VKEY + encodeURIComponent(JSON.stringify(payload)), 9000),
        lane
      );
      const data = j && j.req_0 && j.req_0.data;
      const info = data && data.midurlinfo && data.midurlinfo[0];
      if (!info || !info.purl) return null;
      const base = (data.sip || []).find((s) => s.startsWith('https')) || (data.sip || [])[0];
      if (!base) return null;
      const src = base.replace(/^http:/, 'https:') + info.purl;
      cachePut(key, src, 'qq-trial', { trial: true, full: t.dur });
      return cacheGet(key);
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 预取 ---------------- */
  function preloadNeighbors(days, index) {
    const want = [];
    for (let d = -PRELOAD_RADIUS; d <= PRELOAD_RADIUS; d++) {
      const i = index + d;
      if (i >= 0 && i < days.length && d !== 0) want.push(days[i]);
    }
    // 只保留需要的，清掉其余
    for (const [id, rec] of preloads) {
      if (!want.some((d) => String(d.songId) === id)) { rec.el.src = ''; preloads.delete(id); }
    }
    for (const day of want) preloadOne(day);
  }
  async function preloadOne(day) {
    const id = String(day.songId || '');
    if (!id || preloads.has(id) || id === String(state.day && state.day.songId)) return;
    const rec = { el: new Audio(), src: null };
    preloads.set(id, rec);
    try {
      const r = await resolve(id, 'lazy');
      if (!preloads.has(id)) return;
      if (!r || !r.src) { preloads.delete(id); return; }
      rec.src = r.src;
      rec.el.preload = 'auto';
      rec.el.src = r.src;
    } catch (e) { preloads.delete(id); }
  }

  /* ---------------- 播放核心 ---------------- */
  function bgmEl() { return document.getElementById('bgm'); }
  function pauseBgm() {
    const b = bgmEl();
    if (b && !b.paused) { state.bgmWasPlaying = true; b.pause(); }
  }
  function resumeBgm() {
    const b = bgmEl();
    if (b && state.bgmWasPlaying && !document.hidden) { b.play().catch(() => {}); state.bgmWasPlaying = false; }
  }

  async function playDay(index, day, opts) {
    const token = ++state.token;
    generation++;                      // 作废队列中上一页的解析任务
    state.index = index; state.day = day;
    state.busy = true;
    clearError();
    setState('正在解析直链…');
    let id = String(day.songId || '');
    if (!id) { state.busy = false; fallback('原稿未收录网易云曲目'); return; }
    const alt = ALT_IDS[id];
    if (alt && alt.id) { id = alt.id; state.altNote = alt.note; } else state.altNote = '';

    // 立刻掐掉上一首，避免旧 play() 的残余事件串到新页
    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    let r = null;
    try { r = await resolve(id); } catch (e) { r = null; }
    if (token !== state.token) return;               // 已翻页，丢弃

    /* 网易云无源 → 试 QQ 音乐 60s 试听 */
    if (!r || !r.src) {
      let qq = null;
      try { qq = await resolveQQTrial(String(day.songId)); } catch (e) { qq = null; }
      if (token !== state.token) return;
      if (qq) { r = qq; state.trial = true; } else state.trial = false;
    } else state.trial = false;

    if (!r || !r.src) {
      state.busy = false;
      fallback(ALT_IDS[String(day.songId)] === null ? '该曲网易云已下架 · 可看故事' : '该曲暂无可播直链 · 可去网易云');
      return;
    }

    state.src = r.src; state.via = r.via;
    audio.src = r.src;
    audio.load();
    pauseBgm();
    // 不按「手势窗口」提前放弃：用户已在页面上交互过（翻页本身就是手势），
    // 浏览器一般会放行；真正被拒时 play() 会 reject，再退回手动点播。
    if (opts && opts.force !== true && !state.userInteracted) {
      state.busy = false;
      setState('点击播放');
      return;
    }
    try {
      await audio.play();
      if (token !== state.token) return;
      state.busy = false;
      setState(playLabel());
    } catch (e) {
      state.busy = false;
      if (token === state.token) setState('点击播放');
    }
  }

  function fallback(msg) {
    state.busy = false;
    state.src = null; state.via = 'none';
    audio.removeAttribute('src'); audio.load();
    setState(msg);
    paintProgress(0, 0);
  }

  function togglePlay() {
    markGesture();
    if (!audio.src) {
      if (state.day) playDay(state.index, state.day, { force: true });
      return;
    }
    if (audio.paused) { pauseBgm(); audio.play().catch(() => setState('点击播放')); }
    else { audio.pause(); resumeBgm(); }
  }

  /* ---------------- UI ---------------- */
  /* 统一的播放标签：优先级 altNote > trial > 备用通道 > 正常 */
  function playLabel() {
    if (state.altNote) return '正在播放 · ' + state.altNote;
    if (state.trial) return '正在播放 · QQ 试听 60s';
    if (state.via && state.via !== 'gdstudio' && state.via !== 'none') return '正在播放 · 备用通道 ' + state.via;
    return '正在播放';
  }
  function setState(text) {
    if (els.state) els.state.textContent = text;
    const playing = audio && !audio.paused;
    if (els.btn) {
      els.btn.classList.toggle('playing', !!playing);
      els.btn.setAttribute('aria-label', playing ? '暂停今日歌曲' : '播放今日歌曲');
    }
  }
  function clearError() { if (els.state) els.state.classList.remove('err'); }
  function fmt(s) {
    if (!isFinite(s) || s < 0) return '--:--';
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  }
  const TRIAL_SECONDS = 60;
  function paintProgress(cur, dur) {
    // 某些环境（含部分 CDN）不给 duration 元数据；试听档按已知 60s 兜底显示
    if (!isFinite(dur) && state.trial && cur > 0) dur = TRIAL_SECONDS;
    if (els.time) {
      els.time.textContent = state.trial
        ? fmt(Math.min(cur, TRIAL_SECONDS)) + ' / ' + fmt(TRIAL_SECONDS) + '（试听）'
        : fmt(cur) + ' / ' + fmt(dur);
    }
    if (els.progress) els.progress.style.width = (dur ? Math.min(1, cur / dur) * 100 : 0) + '%';
  }
  function paintAutoplay() {
    if (!els.toggle) return;
    els.toggle.dataset.on = state.autoplay ? '1' : '0';
    els.toggle.textContent = state.autoplay ? '翻页即播放 · 开' : '翻页即播放 · 关';
    els.toggle.setAttribute('aria-pressed', state.autoplay ? 'true' : 'false');
  }

  function bind() {
    audio = document.getElementById('day-audio');
    els = {
      btn: document.getElementById('dp-play'),
      state: document.getElementById('dp-state'),
      time: document.getElementById('dp-time'),
      progress: document.getElementById('dp-progress'),
      bar: document.getElementById('dp-bar'),
      toggle: document.getElementById('dp-toggle'),
      root: document.getElementById('day-player'),
    };
    if (!audio || !els.btn) return;

    els.btn.addEventListener('click', togglePlay);
    els.toggle.addEventListener('click', (e) => {
      e.preventDefault();
      state.autoplay = !state.autoplay;
      try { localStorage.setItem('prc2026.autoplay', state.autoplay ? '1' : '0'); } catch (err) {}
      paintAutoplay();
      markGesture();
      if (state.autoplay && state.day) playDay(state.index, state.day, { force: true });
    });

    audio.addEventListener('play', () => {
      if (!audio.hasAttribute('src')) return;              // 竞态残留事件
      pauseBgm();
      setState(playLabel());
    });
    audio.addEventListener('pause', () => {
      if (!audio.hasAttribute('src')) return;
      if (state.busy) return;              // 切歌过程中的 pause 事件，不代表用户暂停
      setState('已暂停');
    });
    audio.addEventListener('ended', () => {
      setState(state.trial ? '试听结束 · 完整版在网易云' : '播放结束');
      resumeBgm();
    });
    audio.addEventListener('error', () => {
      const id = state.day && state.day.songId;
      if (id && state.via && state.via !== 'qq-trial' && state.via !== 'none') {
        // 直链过期 → 清缓存重取一次（会按优先级重走全部通道）
        delete cache[id]; saveCache();
        playDay(state.index, state.day, { force: true });
        return;
      }
      if (id && state.via === 'qq-trial') {        // 试听链过期 → 清缓存重取一次
        delete cache['qq:' + id]; saveCache();
        playDay(state.index, state.day, { force: true });
        return;
      }
      setState('直链失效，请点网易云');
    });
    audio.addEventListener('timeupdate', () => paintProgress(audio.currentTime, audio.duration));
    audio.addEventListener('loadedmetadata', () => paintProgress(0, audio.duration));
    if (els.bar) els.bar.addEventListener('click', (e) => {
      if (!isFinite(audio.duration)) return;
      const r = els.bar.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audio.duration;
    });

    // 全局手势采样：pointerdown / keydown 都算
    ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
      document.addEventListener(ev, markGesture, { capture: true, passive: true })
    );
    // 快捷键：空格播放/暂停，M 静音。与 app.js 的既有约定一致——焦点在可交互元素上时不抢键
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'BUTTON', 'A'].includes(document.activeElement.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; }
    });

    let saved = null;
    try { saved = localStorage.getItem('prc2026.autoplay'); } catch (e) {}
    const qs = new URLSearchParams(location.search);
    state.autoplay = qs.get('autoplay') === '0' ? false : (saved === '0' ? false : true);
    paintAutoplay();
    paintProgress(0, 0);
    if (pending) { const q = pending; pending = null; window.__prPlayer.onDayChange(q.index, q.day, q.days, q.userInitiated); }
  }

  /* ---------------- 对外钩子 ---------------- */
  window.__prPlayer = {
    init: bind,
    /* app.js 的 setDay 末尾调用 */
    onDayChange(index, day, days, userInitiated) {
      if (!audio) { pending = { index, day, days, userInitiated }; return; }
      if (state.day && String(state.day.songId) === String(day.songId)) return; // 同一首不重开
      state.index = index; state.day = day;
      if (state.autoplay) {
        playDay(index, day, {});
      } else {
        setState('翻页即播放 · 已关闭');
        audio.removeAttribute('src'); audio.load();
      }
      const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 400));
      idle(() => preloadNeighbors(days, index));
    },
    stop() { state.token++; audio && audio.pause(); },
    cache,                                   // 调试用
    breaker,                                 // 通道熔断状态（调试用）
    channels: CHANNELS.map((c) => c.name),
  };
})();
