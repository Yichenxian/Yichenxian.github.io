/* ============================================================
   迷宫寻路 · 像素迷宫  —  游戏逻辑
   原生 Canvas 2D，无依赖。迷宫用递归回溯生成（完美迷宫），
   出口 = 距起点最远的通路格（BFS），因此必然可通关。
   ============================================================ */
(function () {
  'use strict';

  // ==================== CONFIG（想改手感就动这里） ====================
  var CFG = {
    N: 30,                    // 地图每边格数（30 × 30）
    CELL: 24,                 // 每格在画布上的像素（画布 720 × 720）
    MC: 14,                   // 迷宫“单元”每边数量（实际通道 27×27 格）
    WALL: '#1a7f3f',          // 墙（绿格）底色
    WALL_ALT: '#176f37',      // 墙（绿格）棋盘格交替色，制造像素颗粒感
    EXIT: '#ff2d2d',          // 出口红格
    DEFAULT_COLOR: '#ffffff', // 默认主角颜色
    GEN_FRAME_MS: 8,          // 生成动画每帧耗时预算（毫秒）
    MOVE_COOLDOWN: 95,        // 长按连发时的最小间隔（毫秒）
    BEEP_VOL: 0.045           // 音效音量
  };

  var N = CFG.N, CELL = CFG.CELL, SIZE = N * CELL, MC = CFG.MC;
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
  var wrap = $('wrap'), side = $('side');
  var hud = $('hud'), hudTime = $('hudTime'), hudSteps = $('hudSteps');
  var ovStart = $('ovStart'), ovSetup = $('ovSetup'), ovGen = $('ovGen'), ovWin = $('ovWin');
  var btnKb = $('btnKb'), kbLabel = $('kbLabel'), pad = $('pad');
  var barFill = $('barFill'), genPct = $('genPct'), genTip = $('genTip');
  var preview = $('preview'), cpick = $('cpick'), swatches = $('swatches');

  // 离屏画布：迷宫底图只画一次，每帧直接贴图，省性能
  var bgc = document.createElement('canvas');
  bgc.width = bgc.height = SIZE;
  var bx = bgc.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  bx.imageSmoothingEnabled = false;

  // ==================== 状态 ====================
  var state = 'start';            // start | setup | generating | playing | win
  var grid = new Uint8Array(N * N); // 1 = 墙（绿），0 = 通路（纯黑）
  var px = 1, py = 1;             // 主角所在格
  var steps = 0, startTime = 0, elapsed = 0;
  var exitI = -1;                 // 出口格索引
  var playerColor = CFG.DEFAULT_COLOR;
  var gen = null;                 // 生成器上下文
  var bump = null;                // 撞墙抖动反馈
  var lastMoveAt = 0;

  // ==================== 绘制基础 ====================
  function paintCell(i) {
    var cx = i % N, cy = (i / N) | 0;
    if (grid[i] === 1) {
      bx.fillStyle = ((cx + cy) & 1) ? CFG.WALL : CFG.WALL_ALT;
    } else {
      bx.fillStyle = '#000000';
    }
    bx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
  }

  function paintAll() {
    for (var i = 0; i < N * N; i++) paintCell(i);
  }

  function isDark(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) < 110;
  }

  function drawExit(now) {
    var ex = (exitI % N) * CELL, ey = ((exitI / N) | 0) * CELL;
    var k = 0.5 + 0.5 * Math.sin(now / 260);
    var inset = 3;
    ctx.save();
    ctx.shadowColor = 'rgba(255,45,45,' + (0.5 + 0.5 * k).toFixed(3) + ')';
    ctx.shadowBlur = 8 + 12 * k;
    ctx.fillStyle = CFG.EXIT;
    ctx.fillRect(ex + inset, ey + inset, CELL - inset * 2, CELL - inset * 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,' + (0.12 + 0.22 * k).toFixed(3) + ')';
    ctx.fillRect(ex + inset + 3, ey + inset + 3, CELL - inset * 2 - 6, 3);
  }

  function drawPlayer(now) {
    var x = px * CELL, y = py * CELL;
    var ox = 0, oy = 0;
    if (bump && now < bump.until) {
      var t = (bump.until - now) / 120;
      ox = bump.dx * 4 * t;
      oy = bump.dy * 4 * t;
    }
    var inset = 2.5;
    var w = CELL - inset * 2;
    ctx.save();
    ctx.shadowColor = playerColor;
    ctx.shadowBlur = 11;
    ctx.fillStyle = playerColor;
    ctx.fillRect(x + inset + ox, y + inset + oy, w, w);
    ctx.restore();
    // 描边：深色主角也看得见
    ctx.strokeStyle = isDark(playerColor) ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + inset + ox + 0.75, y + inset + oy + 0.75, w - 1.5, w - 1.5);
  }

  function fmt(ms) {
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var cs = Math.floor((ms % 1000) / 10);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s) + '.' + (cs < 10 ? '0' + cs : cs);
  }

  // ==================== 主循环 ====================
  function render(now) {
    ctx.drawImage(bgc, 0, 0);
    if (exitI >= 0 && (state === 'playing' || state === 'win')) drawExit(now);
    if (state === 'playing' || state === 'win') drawPlayer(now);
    if (state === 'playing') hudTime.textContent = fmt(performance.now() - startTime);
    requestAnimationFrame(render);
  }

  // ==================== 音效（程序化合成，无素材） ====================
  var ac = null;
  function ensureAudio() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
    }
    if (ac && ac.state === 'suspended') ac.resume();
  }
  function beep(freq, dur, type, vol) {
    if (!ac) return;
    var t = ac.currentTime;
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || CFG.BEEP_VOL, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // ==================== 界面切换 ====================
  function showOnly(el) {
    [ovStart, ovSetup, ovGen, ovWin].forEach(function (o) {
      o.classList.toggle('show', o === el);
    });
  }

  function setProgress(p, tip) {
    if (p < 0) p = 0; if (p > 1) p = 1;
    barFill.style.width = (p * 100).toFixed(1) + '%';
    genPct.textContent = Math.round(p * 100) + '%';
    if (tip) genTip.textContent = tip;
  }

  // 直接量测容器可用空间，不再靠魔法数字，加了顶栏也不会算错
  function fit() {
    var land = window.innerWidth > window.innerHeight * 1.15;
    document.body.classList.toggle('landscape', land);

    // clientWidth/Height 含 padding，必须减掉才是真正的可用区域
    var padX = 0, padY = 0;
    if (window.getComputedStyle) {
      var cs = window.getComputedStyle(wrap);
      padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    }

    var gap = land ? 16 : 12;
    var availW = Math.max(0, wrap.clientWidth - padX - 2);
    var availH = Math.max(0, wrap.clientHeight - padY - 2);

    if (land) {
      availW -= (side.offsetWidth + gap);
    } else {
      availH -= (side.offsetHeight + gap);
    }

    var s = Math.max(120, Math.min(availW, availH, 600));
    stage.style.width = s + 'px';
    stage.style.height = s + 'px';
  }

  // ==================== 迷宫生成 ====================
  // 算法：递归回溯（DFS 打通），生成的是「完美迷宫」——
  // 任意两个通路格之间恰好有一条路径 → 出口必然可达，100% 可通关。
  function beginGenerate() {
    state = 'generating';
    showOnly(ovGen);
    hud.classList.remove('show');
    setProgress(0, '初始化网格…');

    grid.fill(1);
    paintAll();
    exitI = -1;

    var startI = 1 * N + 1;
    grid[startI] = 0;
    paintCell(startI);

    gen = {
      stack: [[0, 0]],
      seen: new Uint8Array(MC * MC),
      carved: 1,
      total: MC * MC,
      phase: 'carve'
    };
    gen.seen[0] = 1;

    requestAnimationFrame(genLoop);
  }

  function carveStep() {
    var st = gen.stack;
    var cur = st[st.length - 1];
    var cx = cur[0], cy = cur[1];
    var opts = [];
    for (var d = 0; d < 4; d++) {
      var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= MC || ny >= MC) continue;
      if (gen.seen[ny * MC + nx]) continue;
      opts.push([nx, ny]);
    }
    if (opts.length === 0) { st.pop(); return; }

    var pick = opts[(Math.random() * opts.length) | 0];
    var nx2 = pick[0], ny2 = pick[1];

    // 打通两格之间的墙
    var wallI = (1 + cy + ny2) * N + (1 + cx + nx2);
    if (grid[wallI] === 1) { grid[wallI] = 0; paintCell(wallI); }

    // 打通目标格
    var ci = (1 + ny2 * 2) * N + (1 + nx2 * 2);
    grid[ci] = 0;
    paintCell(ci);

    gen.seen[ny2 * MC + nx2] = 1;
    gen.carved++;
    st.push([nx2, ny2]);
  }

  function genLoop() {
    if (state !== 'generating' || !gen) return;

    if (gen.phase === 'carve') {
      var t0 = performance.now();
      while (gen.stack.length && performance.now() - t0 < CFG.GEN_FRAME_MS) {
        carveStep();
      }
      setProgress((gen.carved / gen.total) * 0.94);
      if (!gen.stack.length) {
        gen.phase = 'check';
        setProgress(0.96, '校验通关路径…');
      }
      requestAnimationFrame(genLoop);
      return;
    }

    if (gen.phase === 'check') {
      findExit();
      setProgress(1, '迷宫已就绪');
      gen.phase = 'done';
      setTimeout(function () {
        if (state === 'generating') enterMaze();
      }, 420);
    }
  }

  // 从起点做 BFS，取距离最远的通路格作为出口 —— 保证可达且有挑战
  function findExit() {
    var total = N * N;
    var dist = new Int32Array(total);
    for (var i = 0; i < total; i++) dist[i] = -1;
    var queue = new Int32Array(total);
    var head = 0, tail = 0;
    var s = 1 * N + 1;
    dist[s] = 0;
    queue[tail++] = s;

    var best = s, bestD = 0;
    while (head < tail) {
      var cur = queue[head++];
      var cx = cur % N, cy = (cur / N) | 0;
      var d = dist[cur];
      if (d > bestD) { bestD = d; best = cur; }
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        var ni = ny * N + nx;
        if (grid[ni] === 0 && dist[ni] === -1) {
          dist[ni] = d + 1;
          queue[tail++] = ni;
        }
      }
    }
    exitI = best;
  }

  // ==================== 游戏流程 ====================
  function enterMaze() {
    state = 'playing';
    px = 1; py = 1;
    steps = 0;
    elapsed = 0;
    startTime = performance.now();
    hudSteps.textContent = '0 步';
    hudTime.textContent = '00:00.00';
    hud.classList.add('show');
    showOnly(null);
    beep(660, 0.09, 'triangle', 0.05);
    setTimeout(function () { beep(880, 0.1, 'triangle', 0.04); }, 90);
  }

  function tryMove(dx, dy) {
    if (state !== 'playing') return;
    var nx = px + dx, ny = py + dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N || grid[ny * N + nx] === 1) {
      bump = { dx: dx, dy: dy, until: performance.now() + 120 };
      beep(110, 0.06, 'sawtooth', 0.035);
      return;
    }
    px = nx; py = ny;
    steps++;
    hudSteps.textContent = steps + ' 步';
    beep(520 + Math.random() * 40, 0.03, 'square', 0.022);
    if (ny * N + nx === exitI) winGame();
  }

  function winGame() {
    state = 'win';
    elapsed = performance.now() - startTime;
    hudTime.textContent = fmt(elapsed);
    $('winTime').textContent = fmt(elapsed);
    $('winSteps').textContent = steps;
    hud.classList.remove('show');
    showOnly(ovWin);
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.16, 'triangle', 0.055); }, i * 105);
    });
  }

  function resetToStart() {
    state = 'start';
    gen = null;
    exitI = -1;
    px = 1; py = 1;
    steps = 0; elapsed = 0;
    grid.fill(1);
    paintAll();
    hud.classList.remove('show');
    showOnly(ovStart);
    fit();
  }

  // ==================== 颜色 ====================
  var PALETTE = ['#ffffff', '#ff4d4d', '#ffd93d', '#4dff88', '#4dd2ff',
                 '#b066ff', '#ff6ec7', '#ff9f43', '#00d2d3', '#111111'];

  function setColor(c) {
    playerColor = c;
    preview.style.background = c;
    cpick.value = c;
    var kids = swatches.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('on', kids[i].getAttribute('data-color').toLowerCase() === c.toLowerCase());
    }
  }

  PALETTE.forEach(function (c) {
    var b = document.createElement('button');
    b.className = 'swatch';
    b.type = 'button';
    b.style.background = c;
    b.setAttribute('data-color', c);
    b.title = c;
    b.addEventListener('click', function () { setColor(c); beep(700, 0.04, 'sine', 0.03); });
    swatches.appendChild(b);
  });

  cpick.addEventListener('input', function () { setColor(cpick.value); });
  cpick.addEventListener('change', function () { setColor(cpick.value); });

  // ==================== 输入 ====================
  var KEYMAP = {
    w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
    arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0]
  };

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var d = KEYMAP[e.key.toLowerCase()];
    if (!d) return;
    e.preventDefault();
    if (state !== 'playing') return;
    var now = performance.now();
    if (e.repeat && now - lastMoveAt < CFG.MOVE_COOLDOWN) return;
    lastMoveAt = now;
    tryMove(d[0], d[1]);
  }, { passive: false });

  // 虚拟方向键：点一下走一格；按住 280ms 后自动连走（间隔 MOVE_COOLDOWN）
  var PADMAP = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] };
  var padDelay = null, padRepeat = null;

  function stopPad() {
    if (padDelay) { clearTimeout(padDelay); padDelay = null; }
    if (padRepeat) { clearInterval(padRepeat); padRepeat = null; }
  }

  function startPad(dir) {
    stopPad();
    if (state === 'playing') tryMove(dir[0], dir[1]);
    padDelay = setTimeout(function () {
      padRepeat = setInterval(function () {
        if (state === 'playing') tryMove(dir[0], dir[1]);
      }, CFG.MOVE_COOLDOWN + 35);
    }, 280);
  }

  Array.prototype.forEach.call(pad.querySelectorAll('button'), function (b) {
    var dir = PADMAP[b.getAttribute('data-dir')];
    b.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ensureAudio();
      startPad(dir);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      b.addEventListener(t, stopPad);
    });
    b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  });
  window.addEventListener('pointerup', stopPad);
  window.addEventListener('blur', stopPad);

  // ==================== 按钮 ====================
  $('btnStart').addEventListener('click', function () {
    ensureAudio();
    state = 'setup';
    showOnly(ovSetup);
  });

  $('btnEnter').addEventListener('click', function () {
    ensureAudio();
    beginGenerate();
  });

  $('btnBack').addEventListener('click', function () {
    state = 'start';
    showOnly(ovStart);
  });

  $('btnRestart').addEventListener('click', function () {
    ensureAudio();
    resetToStart();
  });

  btnKb.addEventListener('click', function () {
    ensureAudio();
    var on = pad.classList.toggle('show');
    kbLabel.textContent = on ? '收起虚拟键盘' : '呼出虚拟键盘';
    btnKb.classList.toggle('active', on);
    fit();
  });

  // ==================== 自适应 ====================
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  // ==================== 启动 ====================
  grid.fill(1);
  paintAll();
  setColor(CFG.DEFAULT_COLOR);
  fit();
  requestAnimationFrame(render);
})();
