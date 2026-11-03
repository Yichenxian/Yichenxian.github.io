/* ============================================================
   迷宫寻路 · 背景音乐模块
   ------------------------------------------------------------
   曲目有两层：来源（默认曲 / 玩家上传）×  渲染模式（8BIT / 原声）
   · 8BIT：走 bitcrush.js 转成 11025Hz / 8bit，体积小、有芯片味
   · 原声：直接播原始音频，不做任何处理
   默认曲两个版本都预生成了，玩家上传的则从原始文件按需转换。

   文件扩展名说明见 CFG.TRACK_8BIT 上方注释。
   ------------------------------------------------------------ */
(function () {
  'use strict';

  var VER = 'v20261104n';
  try { console.log('%c背景音乐 ' + VER, 'color:#35e07a;font-weight:700'); } catch (e) {}

  // ==================== CONFIG ====================
  var CFG = {
    // 曲目文件内容都是真音频（WAV 二进制 / MP3 二进制），扩展名却叫 .json —— 这是被环境逼的：
    //   .wav / .mp3 → IDM 一类下载管理器会劫持请求回 204 空响应，装了 IDM 的访客直接没声音；
    //                 本地预览服务也会对 .wav 返回 403。
    //   无扩展名 / .txt → 本地预览服务 404。
    //   .json → 下载器不碰、预览服务放行、GitHub Pages 正常。
    // 浏览器解码只看内容不看 Content-Type，所以不影响播放。
    TRACK_8BIT: 'music/cool-powerful-8bit.json?v=20261104j',
    TRACK_ORIG: 'music/cool-powerful-original.json?v=20261104j',
    TITLE: 'Cool & Powerful',

    VOL_DEFAULT: 48,       // 默认音乐音量（%），与侧栏音效音量独立
    LOOP: true,
    MAX_FILE_MB: 40,       // 上传文件大小上限
    MAX_MINUTES: 8,        // 8BIT 转换只取前 8 分钟（再长展开后内存吃不消）
    STORE_MAX_MB: 12,      // 超过此体积就不写 IndexedDB
    CACHE_VER: 4,          // 缓存结构版本，算法/结构变了要 +1，旧缓存自动丢弃
    KEY_ON: 'maze_music_on',
    KEY_VOL: 'maze_music_vol',
    KEY_TRACK: 'maze_music_track',
    KEY_8BIT: 'maze_music_8bit',
    DB: 'maze8bit',
    STORE: 'tracks',
    RKEY: 'upload'
  };

  // ==================== DOM ====================
  function $(id) { return document.getElementById(id); }
  var bar = $('musicbar');
  if (!bar || !window.Bit8) return;          // 没装音乐条 / 没加载核心，直接不启用

  var btnPlay = $('mbPlay'), title = $('mbTitle');
  // 兜底：旧版页面（HTML 被浏览器缓存、徽标还没有 id）也要能跑，
  // 否则整个模块会在绑定事件时抛错，连音乐都不加载了
  var badge = $('mb8bit') || document.querySelector('.mb-badge');
  var btnUpload = $('mbUpload'), btnReset = $('mbReset'), fileIn = $('mbFile');
  var btnMute = $('mbMute'), volIn = $('mbVol');

  // ==================== 状态 ====================
  var playing = false;
  var converting = false;    // 转码中（禁用播放/上传）
  var loading = false;       // 取曲目/解码中
  var started = false;       // 是否已因用户手势启动过
  var loadToken = 0;         // 防止慢加载覆盖新操作

  var eightBit = true;       // 渲染模式：true=8BIT，false=原声
  var vol = CFG.VOL_DEFAULT / 100;
  var lastVol = CFG.VOL_DEFAULT;
  var musicOn = true;

  var ctx = null, gain = null;
  var srcNode = null;
  var bufStartAt = 0, bufOffset = 0;

  // 当前曲目：kind 区分默认曲/上传曲；buffer 是「当前模式」下的成品，切模式即失效
  var src = { kind: 'default', name: '', bytes: null, packed: null, buffer: null, bufferMode: null };

  function mode() { return eightBit ? '8bit' : 'orig'; }

  // ==================== 音频上下文 ====================
  function ensureCtx() {
    if (window.MazeAudio && window.MazeAudio.ensure) {
      var c = window.MazeAudio.ensure();
      if (c) ctx = c;
    }
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    if (ctx && !gain) {
      gain = ctx.createGain();
      gain.gain.value = vol;
      gain.connect(ctx.destination);
    }
    return ctx;
  }

  // 打包样本 → 可播放缓冲（按设备采样率零阶保持展开）
  function toBuffer(packed) {
    var c = ensureCtx();
    if (!c) return null;
    var rate = c.sampleRate;
    var data = window.Bit8.expand(packed, rate);
    var buf = c.createBuffer(1, data.length, rate);
    if (buf.copyToChannel) buf.copyToChannel(data, 0);
    else buf.getChannelData(0).set(data);
    return buf;
  }

  function decodeWith(c, arrayBuffer) {
    return new Promise(function (res, rej) {
      var ret = c.decodeAudioData(arrayBuffer, res, function (e) { rej(e || new Error('decode fail')); });
      if (ret && ret.then) ret.then(res, rej);
    });
  }

  // 解码「8bit 打包样本」：必须在 packRate 的离线上下文里解，
  // 否则浏览器会重采样到设备速率，台阶被插值磨平、时长也会算错
  var packCtx = null;
  function decodePacked(arrayBuffer) {
    if (!packCtx) {
      try { packCtx = new OfflineAudioContext(1, 1, window.Bit8.OPTS.packRate); } catch (e) { packCtx = null; }
    }
    return decodeWith(packCtx || ensureCtx(), arrayBuffer);
  }

  // 解码任意音频（结果按设备采样率，可直接播放）
  function decodeInput(arrayBuffer) {
    return decodeWith(ensureCtx(), arrayBuffer);
  }

  function crush(decoded) {
    var maxLen = Math.floor(CFG.MAX_MINUTES * 60 * decoded.sampleRate);
    var take = Math.min(decoded.length, maxLen);
    var chs = [];
    for (var c = 0; c < decoded.numberOfChannels; c++) {
      chs.push(decoded.getChannelData(c).subarray(0, take));
    }
    return window.Bit8.process(chs, decoded.sampleRate).packed;
  }

  // ==================== 构建当前模式下的可播放缓冲 ====================
  function fetchBytes(url) {
    return fetch(encodeURI(url), { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    });
  }

  function buildBuffer() {
    if (src.buffer && src.bufferMode === mode()) return Promise.resolve(src.buffer);

    var p;
    if (eightBit) {
      if (src.kind === 'default') {
        p = fetchBytes(CFG.TRACK_8BIT).then(decodePacked).then(function (d) {
          return toBuffer(d.getChannelData(0));
        });
      } else if (src.packed) {
        p = Promise.resolve(toBuffer(src.packed));
      } else {
        // 上传曲第一次切到 8BIT 时才真正转换
        p = decodeInput(src.bytes.slice(0)).then(function (d) {
          return sleep(24).then(function () {
            src.packed = crush(d);
            return toBuffer(src.packed);
          });
        });
      }
    } else {
      p = (src.kind === 'default' ? fetchBytes(CFG.TRACK_ORIG) : Promise.resolve(src.bytes.slice(0)))
            .then(decodeInput);
    }

    return p.then(function (buf) {
      return buf;   // 缓存写入交给调用方，避免过期的构建结果覆盖新曲目
    });
  }

  // ==================== 播放控制 ====================
  function setPlaying(v) {
    playing = !!v;
    bar.classList.toggle('playing', playing);
    btnPlay.setAttribute('aria-label', playing ? '暂停背景音乐' : '播放背景音乐');
  }

  function stopSource() {
    if (srcNode) {
      try { srcNode.onended = null; srcNode.stop(); } catch (e) {}
      try { srcNode.disconnect(); } catch (e) {}
      srcNode = null;
    }
  }

  function bufferPos() {
    if (!srcNode || !src.buffer || !ctx) return bufOffset;
    var d = src.buffer.duration || 1;
    return (bufOffset + (ctx.currentTime - bufStartAt)) % d;
  }

  function startSource(offset) {
    var c = ensureCtx();
    if (!c || !src.buffer || !gain) return false;
    var dur = src.buffer.duration || 1;
    stopSource();
    srcNode = c.createBufferSource();
    srcNode.buffer = src.buffer;
    srcNode.loop = CFG.LOOP;
    srcNode.connect(gain);
    bufOffset = Math.max(0, Math.min(offset || 0, dur - 0.05));
    srcNode.start(0, bufOffset);
    bufStartAt = c.currentTime;
    return true;
  }

  function play() {
    if (converting || playing) return;
    ensureCtx();
    started = true;

    if (src.buffer && src.bufferMode === mode()) {
      if (startSource(bufOffset)) setPlaying(true);
      return;
    }
    if (loading) return;

    loading = true;
    var token = ++loadToken;
    setLabel('加载音乐…');

    buildBuffer().then(function (buf) {
      if (token !== loadToken) { loading = false; return; }   // 期间切了曲目/模式，丢弃
      src.buffer = buf;
      src.bufferMode = mode();
      loading = false;
      renderLabel();
      if (startSource(bufOffset)) setPlaying(true);
    }).catch(function (e) {
      if (token !== loadToken) { loading = false; return; }
      loading = false;
      try { console.warn('[背景音乐] 加载失败:', e); } catch (e2) {}
      // file:// 下浏览器禁止 fetch 本地文件，这里给个能看懂的提示
      flashErr(location.protocol === 'file:'
        ? '本地打开读不到音频，请用 start-local.bat'
        : (eightBit ? '8BIT 版加载失败' : '原声加载失败'));
    });
  }

  function pause() {
    if (playing) bufOffset = bufferPos();
    stopSource();
    setPlaying(false);
  }

  function toggle() {
    if (playing) pause(); else play();
  }

  // 切换渲染模式：保持播放位置，正在放就继续放
  function setMode(on) {
    on = !!on;
    if (eightBit === on) return;
    var pos = playing ? bufferPos() : bufOffset;
    var wasPlaying = playing;

    pause();
    eightBit = on;
    bufOffset = pos;
    src.buffer = null;
    src.bufferMode = null;
    updateBadge();
    renderLabel();
    saveSettings();

    if (wasPlaying) play();
  }

  // 切换曲目来源
  function useTrack(kind, name, bytes, decoded) {
    pause();
    src = {
      kind: kind,
      name: name || '',
      bytes: bytes || null,
      packed: null,
      buffer: null,
      bufferMode: null
    };
    bufOffset = 0;
    if (decoded) {
      // 上传时刚解码好的成品：原声模式可以直接用，省一次解码
      if (eightBit) {
        src.packed = crush(decoded);
        src.buffer = toBuffer(src.packed);
        src.bufferMode = '8bit';
      } else {
        src.buffer = decoded;
        src.bufferMode = 'orig';
      }
    }
    renderLabel();
    saveSettings();
  }

  // ==================== 音量 / 文案 ====================
  function setVol(v, save) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    vol = v / 100;
    volIn.value = v;
    if (v > 0) lastVol = v;
    btnMute.classList.toggle('muted', v === 0);
    btnMute.setAttribute('aria-label', v === 0 ? '取消音乐静音' : '音乐静音');
    if (gain) gain.gain.value = vol;
    if (save) {
      try { localStorage.setItem(CFG.KEY_VOL, String(v)); } catch (e) {}
    }
  }

  function setLabel(txt) {
    title.textContent = txt;
    title.title = txt;
  }

  function renderLabel() {
    if (converting) return;
    bar.classList.remove('err');
    setLabel(src.name || CFG.TITLE);
    btnReset.hidden = (src.kind !== 'upload');
  }

  function updateBadge() {
    if (!badge) return;
    badge.textContent = eightBit ? '8BIT' : '原声';
    badge.classList.toggle('off', !eightBit);
    badge.setAttribute('aria-pressed', eightBit ? 'true' : 'false');
  }

  function setBusy(on, txt) {
    converting = !!on;
    bar.classList.toggle('busy', !!on);
    btnUpload.disabled = !!on;
    btnPlay.disabled = !!on;
    if (on) setLabel(txt || '转换中…');
  }

  function flashErr(msg) {
    bar.classList.add('err');
    setLabel(msg);
    setTimeout(renderLabel, 3200);
  }

  function saveSettings() {
    try {
      localStorage.setItem(CFG.KEY_TRACK, src.kind === 'upload' ? 'upload' : 'default');
      localStorage.setItem(CFG.KEY_8BIT, eightBit ? '1' : '0');
    } catch (e) { /* 隐私模式可能被拒 */ }
  }

  // ==================== 8bit 转换（上传） ====================
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function convertFile(file) {
    if (!file) return;
    if (file.size > CFG.MAX_FILE_MB * 1024 * 1024) {
      flashErr('文件太大（上限 ' + CFG.MAX_FILE_MB + 'MB）');
      return;
    }

    pause();
    setBusy(true, '读取文件…');
    var token = ++loadToken;
    var raw = null;

    file.arrayBuffer()
      .then(function (ab) {
        raw = ab;
        setBusy(true, '解码中…');
        return decodeInput(ab.slice(0));
      })
      .then(function (decoded) {
        if (token !== loadToken) return;
        setBusy(true, eightBit ? '转 8bit…（低通）' : '准备中…');
        return sleep(24).then(function () {
          var name = cleanName(file.name);
          // 先退出 busy，否则 renderLabel() 会被 converting 挡住，标题卡在「准备中…」
          setBusy(false);
          // useTrack 内部按当前模式决定「转 8bit」还是「直接用解码结果」
          useTrack('upload', name, raw, decoded);
          play();

          if (raw.byteLength <= CFG.STORE_MAX_MB * 1024 * 1024) {
            idbPut(CFG.RKEY, {
              v: CFG.CACHE_VER,
              name: name,
              bytes: raw,
              at: Date.now()
            });
          }
        });
      })
      .catch(function (e) {
        if (token !== loadToken) return;
        try { console.warn('[背景音乐] 转换失败:', e); } catch (e2) {}
        setBusy(false);
        flashErr('这个格式转不了，换 mp3/wav 试试');
      });
  }

  function cleanName(n) {
    n = String(n || '我的音乐').replace(/\.[^.]+$/, '');
    return n.length > 26 ? n.slice(0, 25) + '…' : n;
  }

  // ==================== IndexedDB ====================
  function openDB() {
    return new Promise(function (res, rej) {
      var r;
      try { r = indexedDB.open(CFG.DB, 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(CFG.STORE)) r.result.createObjectStore(CFG.STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function idbPut(key, val) {
    openDB().then(function (db) {
      var tx = db.transaction(CFG.STORE, 'readwrite');
      tx.objectStore(CFG.STORE).put(val, key);
      tx.oncomplete = function () { db.close(); };
    }).catch(function () { /* 隐私模式 / 配额不足，忽略 */ });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(CFG.STORE, 'readonly');
        var req = tx.objectStore(CFG.STORE).get(key);
        req.onsuccess = function () { db.close(); res(req.result || null); };
        req.onerror = function () { db.close(); res(null); };
      });
    }).catch(function () { return null; });
  }

  // ==================== 事件 ====================
  btnPlay.addEventListener('click', function () {
    ensureCtx();
    toggle();
    try { localStorage.setItem(CFG.KEY_ON, playing ? '1' : '0'); } catch (e) {}
    musicOn = playing;
  });

  // 徽标即开关：8BIT ⇄ 原声
  if (badge) {
    badge.addEventListener('click', function () {
      ensureCtx();
      setMode(!eightBit);
    });
  }

  btnUpload.addEventListener('click', function () {
    if (converting) return;
    ensureCtx();
    fileIn.click();
  });

  fileIn.addEventListener('change', function () {
    var f = fileIn.files && fileIn.files[0];
    fileIn.value = '';                 // 允许连续上传同一个文件
    if (f) convertFile(f);
  });

  btnReset.addEventListener('click', function () {
    ensureCtx();
    useTrack('default', '', null, null);
    play();                       // 点「切回默认」就是要听默认曲，暂停状态也直接起播
  });

  btnMute.addEventListener('click', function () {
    ensureCtx();
    setVol(vol > 0 ? 0 : (lastVol || CFG.VOL_DEFAULT), true);
  });

  volIn.addEventListener('input', function () {
    setVol(parseFloat(volIn.value) || 0, true);
  });

  // 首次用户手势自动起播（浏览器不允许无手势自动播放）
  document.addEventListener('pointerdown', function (e) {
    if (started) return;
    var t = e.target;
    if (t && t.closest && t.closest('#musicbar')) return;
    if (!musicOn) return;
    started = true;
    play();
  }, true);

  // 切到后台就停，回来接着放
  var resumeAfterHide = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      resumeAfterHide = playing;
      if (playing) pause();
    } else if (resumeAfterHide) {
      resumeAfterHide = false;
      if (musicOn) play();
    }
  });

  // 空格切换播放（不抢 WASD，也不干扰表单控件）
  window.addEventListener('keydown', function (e) {
    if (e.code !== 'Space') return;
    var t = e.target;
    if (t && /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    ensureCtx();
    toggle();
  });

  // ==================== 启动 ====================
  (function init() {
    var savedUpload = false;
    try {
      var on = localStorage.getItem(CFG.KEY_ON);
      musicOn = on === null ? true : on === '1';
      var v = localStorage.getItem(CFG.KEY_VOL);
      setVol(v === null || v === '' ? CFG.VOL_DEFAULT : parseFloat(v), false);
      eightBit = localStorage.getItem(CFG.KEY_8BIT) !== '0';
      savedUpload = localStorage.getItem(CFG.KEY_TRACK) === 'upload';
    } catch (e) {
      setVol(CFG.VOL_DEFAULT, false);
    }

    setPlaying(false);
    updateBadge();
    renderLabel();

    // 上次用过上传曲 → 后台把原始文件读回来（不自动播，等手势）
    if (savedUpload) {
      src.kind = 'upload';
      setLabel('读取上次的曲子…');
      idbGet(CFG.RKEY).then(function (rec) {
        if (!rec || !rec.bytes || rec.v !== CFG.CACHE_VER) throw new Error('no cache');
        src.bytes = rec.bytes;
        src.name = rec.name || '我的音乐';
        renderLabel();
      }).catch(function () {
        src = { kind: 'default', name: '', bytes: null, packed: null, buffer: null, bufferMode: null };
        renderLabel();
        saveSettings();
      });
    }

    window.MazeMusic = {
      play: play, pause: pause, toggle: toggle,
      get playing() { return playing; },
      get kind() { return src.kind; },
      get eightBit() { return eightBit; },
      get title() { return title.textContent; },
      get duration() { return src.buffer ? +src.buffer.duration.toFixed(2) : 0; }
    };
  })();
})();
