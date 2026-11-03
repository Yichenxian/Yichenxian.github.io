/* ============================================================
   迷宫寻路 · 像素迷宫  —  游戏逻辑
   原生 Canvas 2D，无依赖。
   · 迷宫：递归回溯生成「完美迷宫」，出口 = 距起点最远的通路格（BFS），必然可通关。
   · 尺寸：地图边长 30~100 可调；超过 VIEW_MAX 时开摄像机窗口，画面跟随主角平移，
     保证任何尺寸下每格在屏幕上都是同样大小、清晰可辨。
   · 输入：自建按住状态机，按下即走，按住按 STEP_MS 固定节拍连走（不理系统重复延迟）。
   ============================================================ */
(function () {
  'use strict';

  // 版本标记：更新后如果这里还是旧版本号，说明浏览器在用缓存
  var VER = 'v20261104o';
  try { console.log('%c迷宫寻路 ' + VER, 'color:#35e07a;font-weight:700'); } catch (e) {}

  // ==================== CONFIG（想改手感就动这里） ====================
  var CFG = {
    // ---- 地图 ----
    MAP_MIN: 30,              // 地图边长下限
    MAP_MAX: 100,             // 地图边长上限
    MAP_DEFAULT: 30,          // 默认地图边长
    VIEW_MAX: 30,             // 画面一次最多显示多少格；超过则摄像机跟随
    PIXEL_BUDGET: 1200,       // 整图离屏画布的目标边长，用来反推每格像素
    CELL_MIN: 10,             // 每格最小像素
    CELL_MAX: 32,             // 每格最大像素

    // ---- 配色 ----
    WALL: '#1a7f3f',          // 墙（绿格）底色
    WALL_ALT: '#176f37',      // 墙（绿格）棋盘格交替色
    EXIT: '#ff2d2d',          // 出口红格 / 边缘箭头
    DEFAULT_COLOR: '#ffffff', // 默认主角颜色

    // ---- 手感 ----
    STEP_MS: 90,              // 按住方向键时每格间隔（毫秒）
    BUMP_MS: 120,             // 撞墙抖动时长
    PULSE_MS: 260,            // 呼吸/闪烁节奏（出口、箭头共用）

    // ---- 迷雾 ----
    FOG_R: 2,                 // 照亮半径（格）
    FOG_MEMORY: 0.74,         // 走过区域的残影浓度；改成 1 则走过的也全黑
    FOG_REVEAL_MS: 700,       // 进迷宫后先整图亮的时长
    FOG_FADE_MS: 500,         // 之后迷雾淡入的时长

    // ---- 生成动画 ----
    GEN_FRAMES: 70,           // 目标帧数（不管地图多大都约 1.2 秒放完）
    GEN_FRAME_MS: 12,         // 单帧生成耗时上限，防卡顿
    GEN_DONE_MS: 420,         // 进度到 100% 后停顿多久再进迷宫

    // ---- 音效 ----
    BEEP_VOL: 0.045,          // 基准音量（音量 100% 时的峰值）
    VOL_DEFAULT: 60           // 默认音量（%）
  };

  // 这几个会随「地图大小」变化，所以是可变变量而不是常量
  var N = CFG.MAP_DEFAULT;
  var MC = Math.floor((N - 2) / 2);      // 迷宫单元数（通道格 1..2MC-1）
  var CELL = 24;                         // 每格在离屏画布上的像素
  var SIZE = N * CELL;                   // 整图离屏画布边长
  var VIEW = Math.min(N, CFG.VIEW_MAX);  // 画面可见格数
  var camX = 0, camY = 0;                // 摄像机左上角所在格

  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // ==================== 小工具 ====================
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pulse(now) { return 0.5 + 0.5 * Math.sin(now / CFG.PULSE_MS); }
  function inGame() { return state === 'playing' || state === 'win'; }

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
  var wrap = $('wrap'), side = $('side');
  var stagewrap = $('stagewrap'), musicbar = $('musicbar');
  var hud = $('hud'), hudTime = $('hudTime'), hudSteps = $('hudSteps'), hudFog = $('hudFog');
  var ovStart = $('ovStart'), ovSetup = $('ovSetup'), ovGen = $('ovGen'), ovWin = $('ovWin');
  var btnKb = $('btnKb'), kbLabel = $('kbLabel'), pad = $('pad');
  var barFill = $('barFill'), genPct = $('genPct'), genTip = $('genTip');
  var preview = $('preview'), cpick = $('cpick'), swatches = $('swatches');
  var sizeRange = $('sizeRange'), sizeVal = $('sizeVal'), sizeNote = $('sizeNote');
  var fogChk = $('fogChk'), muteBtn = $('muteBtn'), volRange = $('volRange');

  // 离屏画布：整张迷宫底图 / 迷雾层（每帧只贴图，省性能）
  var bgc = document.createElement('canvas');
  var bx = bgc.getContext('2d');
  var fogc = document.createElement('canvas');
  var fx = fogc.getContext('2d');

  // ==================== 状态 ====================
  var state = 'start';            // start | setup | generating | playing | win
  var grid = new Uint8Array(1);   // 1 = 墙（绿），0 = 通路（纯黑）
  var explored = new Uint8Array(1);
  var px = 1, py = 1;
  var steps = 0, startTime = 0;
  var exitI = -1;
  var playerColor = CFG.DEFAULT_COLOR;
  var gen = null;
  var bump = null;

  var fogOn = false;
  var fogRevealAt = 0;      // 刚进迷宫时先亮一下的时间点（之后再淡入迷雾）
  var mapSize = CFG.MAP_DEFAULT;
  var masterVol = CFG.VOL_DEFAULT / 100;
  var lastVol = CFG.VOL_DEFAULT;

  // 按住状态机
  var hold = null;          // { dx, dy, nextAt }
  var pressedKeys = [];     // 当前按住的键，按先后顺序

  // ==================== 尺寸 ====================
  // 换地图尺寸 = 换 N / MC / CELL / VIEW，并重建所有缓冲区
  function applyMapSize(n) {
    n = clamp(Math.round(n) || CFG.MAP_DEFAULT, CFG.MAP_MIN, CFG.MAP_MAX);
    mapSize = n;
    N = n;

    MC = Math.floor((N - 2) / 2);
    if (!isFinite(MC) || MC < 2) MC = 2;

    var c = Math.round((CFG.PIXEL_BUDGET || 1200) / N);
    CELL = clamp(isFinite(c) && c > 0 ? c : 24, CFG.CELL_MIN, CFG.CELL_MAX);

    SIZE = N * CELL;
    if (!isFinite(SIZE) || SIZE <= 0) { CELL = 24; SIZE = N * 24; }

    VIEW = Math.min(N, CFG.VIEW_MAX || 30);
    if (!isFinite(VIEW) || VIEW <= 0) VIEW = Math.min(N, 30);

    grid = new Uint8Array(N * N);
    explored = new Uint8Array(N * N);

    bgc.width = bgc.height = SIZE;
    fogc.width = fogc.height = SIZE;
    bx.imageSmoothingEnabled = false;
    fx.imageSmoothingEnabled = false;

    cv.width = cv.height = VIEW * CELL;
    ctx.imageSmoothingEnabled = false;

    camX = 0; camY = 0;
    exitI = -1;
  }

  function clampCam() {
    if (!isFinite(px)) px = 1;
    if (!isFinite(py)) py = 1;
    if (N <= VIEW) { camX = 0; camY = 0; return; }
    var half = VIEW >> 1;
    camX = clamp(px - half, 0, N - VIEW);
    camY = clamp(py - half, 0, N - VIEW);
  }

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

  // ==================== 迷雾 ====================
  // 主角身周 FOG_R 格全亮；走过的留残影；没去过的纯黑。
  // 终点红格画在迷雾之上，永远可见。
  function rebuildFog() {
    fx.clearRect(0, 0, SIZE, SIZE);
    if (!fogOn) return;
    for (var i = 0; i < N * N; i++) {
      var cx = i % N, cy = (i / N) | 0;
      var d = Math.max(Math.abs(cx - px), Math.abs(cy - py));
      if (d <= CFG.FOG_R) explored[i] = 1;

      var a;
      if (d <= CFG.FOG_R) {
        a = 0;
      } else if (d === CFG.FOG_R + 1) {
        a = explored[i] ? CFG.FOG_MEMORY * 0.57 : 0.72;
      } else {
        a = explored[i] ? CFG.FOG_MEMORY : 1;
      }

      if (a > 0) {
        fx.fillStyle = a >= 1 ? '#000000' : 'rgba(0,0,0,' + a + ')';
        fx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
      }
    }
  }

  function resetFog() {
    explored.fill(0);
    fx.clearRect(0, 0, SIZE, SIZE);
    rebuildFog();
  }

  function isDark(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) < 110;
  }

  // 出口红格：画在迷雾之上，所以永远亮着
  function drawExit(now) {
    var ex = ((exitI % N) - camX) * CELL;
    var ey = (((exitI / N) | 0) - camY) * CELL;
    var k = pulse(now);
    var inset = Math.max(1.5, CELL * 0.12);
    ctx.save();
    ctx.shadowColor = 'rgba(255,45,45,' + (0.5 + 0.5 * k).toFixed(3) + ')';
    ctx.shadowBlur = CELL * (0.35 + 0.5 * k);
    ctx.fillStyle = CFG.EXIT;
    ctx.fillRect(ex + inset, ey + inset, CELL - inset * 2, CELL - inset * 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,' + (0.12 + 0.22 * k).toFixed(3) + ')';
    ctx.fillRect(ex + inset + CELL * 0.14, ey + inset + CELL * 0.14,
                 Math.max(1, CELL - inset * 2 - CELL * 0.28), Math.max(1, CELL * 0.12));
  }

  // 出口跑出视野时，在画面边缘画一个指向它的箭头：红色填充 + 白色描边，
  // 描边保证它在绿墙和纯黑底上都看得清。
  function drawExitHint(now) {
    var vw = VIEW * CELL;
    var ex = ((exitI % N) - camX) * CELL + CELL / 2;
    var ey = (((exitI / N) | 0) - camY) * CELL + CELL / 2;
    // 出口已经在视野内（留一格余量）就不用箭头
    if (ex > -CELL && ex < vw + CELL && ey > -CELL && ey < vw + CELL) return;

    // 从主角出发沿「主角 → 出口」方向求与内缩边框的交点，把箭头钉在边上
    var cx = (px - camX) * CELL + CELL / 2;
    var cy = (py - camY) * CELL + CELL / 2;
    var dx = ex - cx, dy = ey - cy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;

    var pad = CELL * 1.25;
    var tx = dx > 0 ? (vw - pad - cx) / dx : (dx < 0 ? (pad - cx) / dx : Infinity);
    var ty = dy > 0 ? (vw - pad - cy) / dy : (dy < 0 ? (pad - cy) / dy : Infinity);
    var t = Math.min(tx, ty);
    var mx = cx + dx * t, my = cy + dy * t;

    var k = pulse(now);
    var s = CELL * (0.95 + 0.12 * k);   // 呼吸缩放，让它更抢眼

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.atan2(dy, dx));

    // 带内凹尾部的箭头轮廓
    ctx.beginPath();
    ctx.moveTo(s * 0.74, 0);
    ctx.lineTo(-s * 0.50, -s * 0.64);
    ctx.lineTo(-s * 0.24, 0);
    ctx.lineTo(-s * 0.50, s * 0.64);
    ctx.closePath();

    // 先画红色光晕填充
    ctx.shadowColor = 'rgba(255,45,45,' + (0.55 + 0.45 * k).toFixed(3) + ')';
    ctx.shadowBlur = CELL * (0.5 + 0.7 * k);
    ctx.fillStyle = CFG.EXIT;
    ctx.fill();

    // 再描白边（关掉阴影，否则白边会糊）
    ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.6, CELL * 0.13);
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.stroke();

    ctx.restore();
  }

  function drawPlayer(now) {
    var x = (px - camX) * CELL, y = (py - camY) * CELL;
    var ox = 0, oy = 0;
    if (bump && now < bump.until) {
      var t = (bump.until - now) / CFG.BUMP_MS;
      ox = bump.dx * CELL * 0.17 * t;
      oy = bump.dy * CELL * 0.17 * t;
    }
    var inset = Math.max(1, CELL * 0.1);
    var w = CELL - inset * 2;
    ctx.save();
    ctx.shadowColor = playerColor;
    ctx.shadowBlur = CELL * 0.45;
    ctx.fillStyle = playerColor;
    ctx.fillRect(x + inset + ox, y + inset + oy, w, w);
    ctx.restore();
    ctx.strokeStyle = isDark(playerColor) ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.5)';
    ctx.lineWidth = Math.max(1, CELL * 0.06);
    ctx.strokeRect(x + inset + ox + 0.5, y + inset + oy + 0.5, w - 1, w - 1);
  }

  function fmt(ms) {
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var cs = Math.floor((ms % 1000) / 10);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s) + '.' + (cs < 10 ? '0' + cs : cs);
  }

  // ==================== 主循环 ====================
  // render 只负责"调度"，真正的绘制在 draw 里。
  // 这样即使某一帧绘制抛异常，动画循环也不会被打死（否则画面会永久停住，
  // 表现就是"人能动、但画面不动/全黑"）。
  var renderErrorLogged = false;

  function render(now) {
    try {
      draw(now);
    } catch (e) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        try { console.error('[迷宫] 渲染异常（已自动降级，循环继续）:', e); } catch (e2) {}
      }
    }
    requestAnimationFrame(render);
  }

  // 迷雾层：开局先整图亮一会儿再淡入，并且永远给主角留一块视野
  function drawFog(now, vw) {
    var age = now - fogRevealAt;
    if (age < 0) return;                     // 还在「整图亮」阶段

    var fa = age < CFG.FOG_FADE_MS ? age / CFG.FOG_FADE_MS : 1;
    if (fa > 0) {
      ctx.globalAlpha = fa;
      ctx.drawImage(fogc, camX * CELL, camY * CELL, vw, vw, 0, 0, vw, vw);
      ctx.globalAlpha = 1;
    }

    // 硬保险：不论迷雾层出了什么问题，主角身周这块永远重新贴回底图，
    // 保证「视野」不可能被迷雾整个吃掉（黑屏的最后一道防线）
    var area = Math.min(SIZE, (CFG.FOG_R * 2 + 1) * CELL);
    if (area <= 0) return;
    var wx = clamp((px - CFG.FOG_R) * CELL, 0, SIZE - area);
    var wy = clamp((py - CFG.FOG_R) * CELL, 0, SIZE - area);
    ctx.drawImage(bgc, wx, wy, area, area, wx - camX * CELL, wy - camY * CELL, area, area);
  }

  function draw(now) {
    var vw = VIEW * CELL;
    var canDraw = SIZE > 0 && vw > 0;

    // 自愈：已经进入游玩态却还挂着遮罩（任何异常导致的"黑屏"）→ 立刻解除
    if (state === 'playing' && ovGen.classList.contains('show')) showOnly(null);

    if (state === 'generating') {
      // 生成阶段：把整张图缩进窗口，能看到全局开凿过程
      if (canDraw) ctx.drawImage(bgc, 0, 0, SIZE, SIZE, 0, 0, vw, vw);
    } else if (canDraw) {
      ctx.drawImage(bgc, camX * CELL, camY * CELL, vw, vw, 0, 0, vw, vw);
      if (fogOn && inGame()) drawFog(now, vw);
    }

    if (exitI >= 0 && inGame()) {
      drawExitHint(now);   // 出口在视野外 → 边缘箭头
      drawExit(now);       // 视野内 → 红格本体（画在迷雾之上）
      drawPlayer(now);
    }

    // 按住连发：按下即走，之后每 STEP_MS 一格（不用系统按键重复）
    if (hold && state === 'playing') {
      var guard = 0;
      while (now >= hold.nextAt && guard++ < 3) {
        tryMove(hold.dx, hold.dy);
        hold.nextAt += CFG.STEP_MS;
      }
    }

    if (state === 'playing') hudTime.textContent = fmt(performance.now() - startTime);
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
    if (!ac || masterVol <= 0) return;
    var t = ac.currentTime;
    var peak = (vol || CFG.BEEP_VOL) * (masterVol / (CFG.VOL_DEFAULT / 100));
    peak = Math.max(0.0002, Math.min(1, peak));
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.03);
  }

  // 背景音乐模块复用同一个 AudioContext（不重复开上下文）
  window.MazeAudio = {
    ensure: function () { ensureAudio(); return ac; },
    get ctx() { return ac; }
  };

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

  // 直接量测容器可用空间，加了顶栏也不会算错
  function fit() {
    var land = window.innerWidth > window.innerHeight * 1.15;
    document.body.classList.toggle('landscape', land);

    var padX = 0, padY = 0;
    if (window.getComputedStyle) {
      var cs = window.getComputedStyle(wrap);
      padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    }

    var gap = land ? 16 : 12;

    // 音乐条占掉的竖向空间（含它与画面之间的 8px 间距）
    var MB_GAP = 8;
    var mbH = (musicbar && !musicbar.hidden) ? (musicbar.offsetHeight + MB_GAP) : 0;

    var availW = Math.max(0, wrap.clientWidth - padX - 2);
    var availH = Math.max(0, wrap.clientHeight - padY - 2 - mbH);

    if (land) {
      availW -= (side.offsetWidth + gap);
    } else {
      availH -= (side.offsetHeight + gap);
    }

    var s = Math.max(120, Math.min(availW, availH, 600));
    stage.style.width = s + 'px';
    stage.style.height = s + 'px';

    // 音乐条和画面同宽；画面越窄，条上的次要控件逐级收起来
    if (stagewrap) stagewrap.style.width = s + 'px';
    if (musicbar) {
      musicbar.style.width = s + 'px';
      musicbar.classList.toggle('wide', s >= 420);
      musicbar.classList.toggle('compact', s < 320);
      musicbar.classList.toggle('tiny', s < 260);
    }
  }

  // ==================== 迷宫生成 ====================
  // 递归回溯（DFS 打通）→ 完美迷宫：任意两个通路格恰好一条路径，出口必然可达。
  function beginGenerate() {
    state = 'generating';
    hold = null;
    showOnly(ovGen);
    hud.classList.remove('show');
    setProgress(0, '初始化网格…');

    applyMapSize(mapSize);
    grid.fill(1);
    paintAll();
    // 新一局的迷雾在 enterMaze 里统一重建，这里只把旧数据清掉
    explored.fill(0);
    fx.clearRect(0, 0, SIZE, SIZE);

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

    var wallI = (1 + cy + ny2) * N + (1 + cx + nx2);
    if (grid[wallI] === 1) { grid[wallI] = 0; paintCell(wallI); }

    var ci = (1 + ny2 * 2) * N + (1 + nx2 * 2);
    grid[ci] = 0;
    paintCell(ci);

    gen.seen[ny2 * MC + nx2] = 1;
    gen.carved++;
    st.push([nx2, ny2]);
  }

  function genLoop() {
    var again = false;
    try {
      if (state !== 'generating' || !gen) return;

      if (gen.phase === 'carve') {
        // 按「总步数 / 70 帧」分片：无论地图多大，动画都约 1.2 秒放完
        var budget = Math.max(4, Math.ceil((gen.total * 2) / CFG.GEN_FRAMES));
        var t0 = performance.now();
        var k = 0;
        while (gen.stack.length && k < budget && performance.now() - t0 < CFG.GEN_FRAME_MS) {
          carveStep();
          k++;
        }
        setProgress((gen.carved / gen.total) * 0.94);
        if (!gen.stack.length) {
          gen.phase = 'check';
          setProgress(0.96, '校验通关路径…');
        }
        again = true;

      } else if (gen.phase === 'check') {
        findExit();
        setProgress(1, '迷宫已就绪');
        gen.phase = 'done';
        setTimeout(function () {
          if (state === 'generating') enterMaze();
        }, CFG.GEN_DONE_MS);
      }
    } catch (e) {
      // 生成过程出任何异常，都不能把玩家关在加载界面里
      try { console.error('[迷宫] 生成异常:', e); } catch (e2) {}
      if (state === 'generating') {
        state = 'start';
        gen = null;
        hud.classList.remove('show');
        showOnly(ovStart);
        genTip.textContent = '生成失败，请重试';
      }
      again = false;
    }
    if (again) requestAnimationFrame(genLoop);
  }

  // 从起点 BFS，取距离最远的通路格作为出口
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
    startTime = performance.now();
    hold = null;
    clampCam();
    resetFog();
    fogRevealAt = performance.now() + CFG.FOG_REVEAL_MS;   // 先整图亮一会儿，再淡入迷雾

    // 先解除遮罩再动别的 UI：万一后面任何一步出异常，也不会把画面锁在黑屏上
    showOnly(null);
    hud.classList.add('show');
    if (hudFog) hudFog.hidden = !fogOn;
    hudSteps.textContent = '0 步';
    hudTime.textContent = '00:00.00';

    beep(660, 0.09, 'triangle', 0.05);
    setTimeout(function () { beep(880, 0.1, 'triangle', 0.04); }, 90);
  }

  function tryMove(dx, dy) {
    if (state !== 'playing') return;
    var nx = px + dx, ny = py + dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N || grid[ny * N + nx] === 1) {
      bump = { dx: dx, dy: dy, until: performance.now() + CFG.BUMP_MS };
      beep(110, 0.06, 'sawtooth', 0.035);
      return;
    }
    px = nx; py = ny;
    steps++;
    hudSteps.textContent = steps + ' 步';
    clampCam();
    rebuildFog();
    beep(520 + Math.random() * 40, 0.03, 'square', 0.022);
    if (ny * N + nx === exitI) winGame();
  }

  function winGame() {
    state = 'win';
    hold = null;
    var spend = performance.now() - startTime;
    hudTime.textContent = fmt(spend);
    $('winTime').textContent = fmt(spend);
    $('winSteps').textContent = steps;
    hud.classList.remove('show');
    showOnly(ovWin);
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.16, 'triangle', 0.055); }, i * 105);
    });
  }

  // 把游戏状态彻底复位回「开始」界面。
  // 注意：这里不复位音乐模块 —— 它独立运行，重开一局不该打断正在放的音乐。
  function resetToStart() {
    state = 'start';
    gen = null;
    hold = null;
    bump = null;
    pressedKeys.length = 0;
    exitI = -1;
    px = 1; py = 1;
    steps = 0;
    camX = 0; camY = 0;
    fogRevealAt = 0;
    startTime = 0;
    renderErrorLogged = false;   // 复位渲染异常标记，重新给一次日志机会
    grid.fill(1);
    paintAll();
    resetFog();
    hudSteps.textContent = '0 步';
    hudTime.textContent = '00:00.00';
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

  // ==================== 输入：按住状态机 ====================
  // 完全不用系统按键重复（e.repeat 直接丢弃），所以没有那 ~500ms 的初始延迟。
  // 按下 → 立刻走一格；继续按住 → 每 STEP_MS 走一格。
  var KEYMAP = {
    w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
    arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0]
  };
  var PADMAP = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] };

  function startHold(dx, dy) {
    if (state !== 'playing') return;
    hold = { dx: dx, dy: dy, nextAt: performance.now() + CFG.STEP_MS };
    tryMove(dx, dy);          // 第一下立刻走
  }

  function stopHold() { hold = null; }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();
    var d = KEYMAP[key];
    if (!d) return;
    e.preventDefault();
    if (e.repeat) return;                    // 系统重复一律不用
    if (state !== 'playing') return;
    if (pressedKeys.indexOf(key) < 0) pressedKeys.push(key);
    startHold(d[0], d[1]);
  }, { passive: false });

  window.addEventListener('keyup', function (e) {
    var key = e.key.toLowerCase();
    if (!KEYMAP[key]) return;
    var i = pressedKeys.indexOf(key);
    if (i >= 0) pressedKeys.splice(i, 1);
    if (i === pressedKeys.length) {
      // 松开的正是当前方向：若还按着别的方向键就平滑接上
      var last = pressedKeys[pressedKeys.length - 1];
      if (last && KEYMAP[last]) {
        var d = KEYMAP[last];
        hold = { dx: d[0], dy: d[1], nextAt: performance.now() + CFG.STEP_MS };
      } else {
        hold = null;
      }
    }
  });

  window.addEventListener('blur', function () { pressedKeys.length = 0; hold = null; });

  // 虚拟方向键：与键盘共用同一套状态机
  Array.prototype.forEach.call(pad.querySelectorAll('button'), function (b) {
    var dir = PADMAP[b.getAttribute('data-dir')];
    b.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ensureAudio();
      startHold(dir[0], dir[1]);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      b.addEventListener(t, stopHold);
    });
    b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  });
  window.addEventListener('pointerup', stopHold);

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
    // 不再整页刷新：刷新会把背景音乐一起打断，而且回来还要再点一次才有声。
    // 改成在内存里彻底复位，音乐模块独立运行，重开一局不打断它。
    resetToStart();
  });

  btnKb.addEventListener('click', function () {
    ensureAudio();
    var on = pad.classList.toggle('show');
    kbLabel.textContent = on ? '收起虚拟键盘' : '呼出虚拟键盘';
    btnKb.classList.toggle('active', on);
    fit();
  });

  // ==================== 地图大小 / 迷雾 / 音量 ====================
  function saveSettings() {
    try {
      localStorage.setItem('maze_size', String(mapSize));
      localStorage.setItem('maze_fog', fogOn ? '1' : '0');
      localStorage.setItem('maze_vol', String(Math.round(masterVol * 100)));
    } catch (e) { /* 隐私模式或 file:// 下可能被拒，忽略即可 */ }
  }

  function renderSizeLabel() {
    sizeVal.textContent = mapSize + '×' + mapSize;
    sizeNote.hidden = mapSize <= CFG.VIEW_MAX;
  }

  sizeRange.addEventListener('input', function () {
    mapSize = clamp(parseInt(sizeRange.value, 10) || CFG.MAP_DEFAULT, CFG.MAP_MIN, CFG.MAP_MAX);
    renderSizeLabel();
    saveSettings();
  });
  sizeRange.addEventListener('change', function () {
    ensureAudio();
    beep(700, 0.05, 'sine', 0.03);
  });

  fogChk.addEventListener('change', function () {
    ensureAudio();
    fogOn = !!fogChk.checked;
    if (state === 'playing') resetFog();
    saveSettings();
    beep(780, 0.05, 'sine', 0.03);
  });

  function setVol(v) {
    v = clamp(Math.round(v), 0, 100);
    masterVol = v / 100;
    volRange.value = v;
    muteBtn.classList.toggle('muted', v === 0);
    muteBtn.setAttribute('aria-label', v === 0 ? '取消静音' : '静音');
    if (v > 0) lastVol = v;
  }

  volRange.addEventListener('input', function () {
    setVol(parseFloat(volRange.value) || 0);
    saveSettings();
  });
  volRange.addEventListener('change', function () {
    ensureAudio();
    setVol(parseFloat(volRange.value) || 0);
    saveSettings();
    beep(660, 0.09, 'triangle', 0.05);
  });

  muteBtn.addEventListener('click', function () {
    ensureAudio();
    if (masterVol > 0) {
      setVol(0);
    } else {
      setVol(lastVol || CFG.VOL_DEFAULT);
      beep(560, 0.08, 'triangle', 0.05);
    }
    saveSettings();
  });

  // 读取上次的设置
  (function loadSettings() {
    try {
      var s = parseInt(localStorage.getItem('maze_size'), 10);
      mapSize = (!s || s < CFG.MAP_MIN || s > CFG.MAP_MAX) ? CFG.MAP_DEFAULT : s;
      fogOn = localStorage.getItem('maze_fog') === '1';
      var v = localStorage.getItem('maze_vol');
      setVol(v === null || v === '' ? CFG.VOL_DEFAULT : parseFloat(v));
    } catch (e) {
      mapSize = CFG.MAP_DEFAULT;
      setVol(CFG.VOL_DEFAULT);
    }
    sizeRange.value = mapSize;
    fogChk.checked = fogOn;
    renderSizeLabel();
  })();

  // ==================== 自适应 ====================
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  // ==================== 启动 ====================
  applyMapSize(mapSize);
  grid.fill(1);
  paintAll();
  setColor(CFG.DEFAULT_COLOR);
  fit();
  requestAnimationFrame(render);
})();
