/* ============================================================
   迷宫寻路 · 像素迷宫  —  游戏逻辑
   原生 Canvas 2D，无依赖。单文件闭包，不污染全局。
   对外只暴露两个东西：MazeAudio（给音乐模块复用 AudioContext）、
   MazeDebug（只给自动化测试 / 控制台排查用，正常玩法不依赖它）。

   结构（自上而下就是执行顺序）：
     CFG                       所有可调参数（想改手感只动这里）
     ST / DIRS / 尺寸变量      状态机取值、方向表、当前地图尺寸
     小工具 / DOM / 状态       只有这里碰 document
     applyMapSize / fit        尺寸与自适应
     render / update / draw    一帧 = 先算状态，再画画（两者不混）
     敌人 / QTE / 血量 / 救命   对抗系统，四个小节各自成组，互不越界
     界面切换 / 生成 / 流程     遮罩、迷宫生成、开局与结算
     颜色 / 输入 / 设置         交互与持久化

   · 迷宫：生长树（Growing Tree）生成完美迷宫；出口 = 距起点 BFS 最远的通路格，
     必然可通关。CFG.BRANCH_P 控制岔路密度（1 = 一条长廊，越小岔路越多）。
   · 尺寸：地图边长 30~100 可调；超过 VIEW_MAX 时开摄像机窗口跟随主角，
     保证任何尺寸下每格在屏幕上都是同样大小。
   · 输入：自建按住状态机，按下即走，按住按 STEP_MS 固定节拍连走（不理系统重复延迟）。
   · 对抗：终点附近生成「红边白格 + 黑瞳」的敌人（数量随地图变大，最多 7 个）。
     平时按主人公一半速度游荡、不追人。**同一条直走廊、中间无墙**（hasLineOfSight）
     且落在视野内才算对上眼 → 先定住闪 1 秒「反击！」→ 再弹 QTE（两个方向键 + 1.8 秒
     倒计时）。按对 → 裂开消失；按错/超时/多按 → 变红加速到 2/3 速度追人，1.5 秒后
     若仍在视野里可以再判。被撞掉一颗心，0.8 秒无敌帧，8 秒回一颗，三颗掉光即失败。
   ============================================================ */
(function () {
  'use strict';

  // 版本标记：更新后如果这里还是旧版本号，说明浏览器在用缓存
  var VER = 'v20261105i';
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
    WALL: '#1a7f3f',          // 墙（绿格）底色（整片统一，不做棋盘格交替）
    EXIT: '#ff2d2d',          // 出口红格 / 边缘箭头
    DEFAULT_COLOR: '#ffffff', // 默认主角颜色

    // ---- 手感 ----
    STEP_MS: 90,              // 按住方向键时每格间隔（毫秒）
    STEP_MAX_CATCHUP: 3,      // 单帧最多补走几格（掉帧后别一口气穿墙）
    BUMP_MS: 120,             // 撞墙抖动时长
    PULSE_MS: 260,            // 呼吸/闪烁节奏（出口、箭头共用）

    // ---- 迷雾 ----
    FOG_R: 2,                 // 照亮半径（格）
    FOG_MEMORY: 0.74,         // 走过区域的残影浓度；改成 1 则走过的也全黑
    FOG_RIM_LIT: 0.57,        // 照亮圈外一圈：走过的地方留多少残影
    FOG_RIM_DARK: 0.72,       // 照亮圈外一圈：没走过的地方有多黑

    // ---- 岔路 ----
    // 生长树（Growing Tree）的「取最近格」概率：
    //   1.0 = 纯递归回溯，一条蜿蜒长廊，约 20 格才一个岔路口（简单）
    //   0.75 = 岔路明显变多，仍保留较长的走廊（推荐）
    //   0.5  = 接近 Prim，灌木型，岔路密集但每段都短（手忙脚乱）
    BRANCH_P: 0.72,

    // ---- 终点指引 ----
    HINT_DEFAULT: true,       // 默认开启「出口在画面外时边缘箭头」
    HINT_PAD: 1.3,            // 箭头离画面边距（格）；底部另加 HUD 高度

    // ---- 生成动画 ----
    GEN_FRAMES: 70,           // 目标帧数（不管地图多大都约 1.2 秒放完）
    GEN_FRAME_MS: 12,         // 单帧生成耗时上限，防卡顿
    GEN_DONE_MS: 420,         // 进度到 100% 后停顿多久再进迷宫

    // ---- 敌人 ----
    // 速度都以「主人公按住移动键时的速度」为 1（= 每 STEP_MS 走一格）
    ENEMY_ROAM: 0.5,          // 巡游：一半速度，且不追人
    ENEMY_RAGE: 2 / 3,        // QTE 失败后：三分之二速度，开始追人
    ENEMY_STEP: 10,           // 每多这么多格边长 +1 个敌人
    ENEMY_MAX: 7,             // 敌人数量上限（90~100 格按 7 个算）
    ENEMY_EXIT_R: 4,          // 在终点周围这个半径（格）内生成
    ENEMY_MIN_DIST: 12,       // 与起点的路径距离下限：别一开局就撞上
    ENEMY_HIT_R: 0.55,        // 与主人公重叠判定（格）

    // ---- QTE（对抗敌人） ----
    QTE_KEYS: 2,              // 需要按下的方向键数量（按顺序）
    QTE_WARN_MS: 1000,        // 判定前的「反击！」提醒时长（此期间敌我定住）
    QTE_MS: 1800,             // 判定时长：两个键 1.8 秒，手够快也够紧张
    QTE_LOCK_MS: 1500,        // 判定失败后，同一个敌人多久才能再被判定
    QTE_GAP_MS: 700,          // 两次判定之间的最小间隔，防连环弹窗
    QTE_RANGE: 6,             // 无迷雾时，进到这个格数内才算「对上眼」
    CRACK_MS: 560,            // 敌人裂开消失的动画时长

    // ---- 血量 ----
    HP_MAX: 3,                // 三颗心
    INVULN_MS: 800,           // 掉血后的无敌帧
    REGEN_MS: 8000,           // 掉血起满这么久回一颗心

    // ---- 音效 ----
    BEEP_VOL: 0.045,          // 基准音量（音量 100% 时的峰值）
    VOL_DEFAULT: 60           // 默认音量（%）
  };

  // 状态机取值集中在这：散落各处的裸字符串拼错一个字母就是静默 bug
  var ST = { START: 'start', SETUP: 'setup', GENERATING: 'generating', PLAYING: 'playing', WIN: 'win', LOSE: 'lose' };

  // 方向只定义一次，键盘和虚拟键都查这张表
  var DIR_BY_NAME = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  var DIRS = [DIR_BY_NAME.up, DIR_BY_NAME.right, DIR_BY_NAME.down, DIR_BY_NAME.left];

  // 这几个会随「地图大小」变化，所以是可变变量而不是常量
  var N = CFG.MAP_DEFAULT;
  var MC = Math.floor((N - 2) / 2);      // 迷宫单元数（通道格 1..2MC-1）
  var CELL = 24;                         // 每格在离屏画布上的像素
  var SIZE = N * CELL;                   // 整图离屏画布边长
  var VIEW = Math.min(N, CFG.VIEW_MAX);  // 画面可见格数
  var camX = 0, camY = 0;                // 摄像机左上角所在格
  // 画面 CSS 宽度 / HUD 高度：每帧都读 DOM 会强制重排，所以只在 fit() 和进迷宫时量一次
  var stageCssW = 0, hudCssH = 0;

  // ==================== 小工具 ====================
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pulse(now) { return 0.5 + 0.5 * Math.sin(now / CFG.PULSE_MS); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function inGame() { return state === ST.PLAYING || state === ST.WIN || state === ST.LOSE; }

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
  var wrap = $('wrap'), side = $('side');
  var stagewrap = $('stagewrap'), musicbar = $('musicbar'), toolbar = $('toolbar');
  var hud = $('hud'), hudTime = $('hudTime'), hudSteps = $('hudSteps'), hudFog = $('hudFog');
  var ovStart = $('ovStart'), ovSetup = $('ovSetup'), ovGen = $('ovGen'), ovWin = $('ovWin');
  var btnKb = $('btnKb'), kbLabel = $('kbLabel'), pad = $('pad');
  var btnRestart = $('btnRestart');
  var btnRescue = $('btnRescue');
  var btnStart = $('btnStart'), btnEnter = $('btnEnter'), btnBack = $('btnBack');
  var winTime = $('winTime'), winSteps = $('winSteps');
  var barFill = $('barFill'), genPct = $('genPct'), genTip = $('genTip');
  var preview = $('preview'), cpick = $('cpick'), swatches = $('swatches');
  var sizeRange = $('sizeRange'), sizeVal = $('sizeVal'), sizeNote = $('sizeNote');
  var fogChk = $('fogChk'), muteBtn = $('muteBtn'), volRange = $('volRange');
  var hintChk = $('hintChk'), hintField = $('hintField'), hintNote = $('hintNote');
  var heartsBox = $('hearts');
  var qteBox = $('qte'), qteKeys = $('qteKeys'), qteBar = $('qteBar'), qteNum = $('qteNum');
  var warnBox = $('qteWarn'), warnBar = $('qteWarnBar');
  var ovLose = $('ovLose'), loseTime = $('loseTime'), loseSteps = $('loseSteps'), btnRetry = $('btnRetry');
  // 所有遮罩集中一处：显示/收起、compact 档位都查这张表，新增遮罩只改这里
  var OVERLAYS = [ovStart, ovSetup, ovGen, ovWin, ovLose];

  // 离屏画布：整张迷宫底图 / 迷雾层（每帧只贴图，省性能）
  var bgc = document.createElement('canvas');
  var bx = bgc.getContext('2d');
  var fogc = document.createElement('canvas');
  var fx = fogc.getContext('2d');

  // ==================== 状态 ====================
  var state = ST.START;
  var curOverlay = null;          // 当前挂着的遮罩（draw 的自愈检查用它，免去每帧读 DOM）
  var grid = new Uint8Array(1);   // 1 = 墙（绿），0 = 通路（纯黑）
  var explored = new Uint8Array(1);
  var px = 1, py = 1;
  var steps = 0, startTime = 0;
  var exitI = -1;
  var playerColor = CFG.DEFAULT_COLOR;
  var gen = null;
  var bump = null;

  var fogOn = false;
  var hintOn = CFG.HINT_DEFAULT;   // 终点指引箭头：出口不在视野内时显示
  var mapSize = CFG.MAP_DEFAULT;
  var masterVol = CFG.VOL_DEFAULT / 100;
  var lastVol = CFG.VOL_DEFAULT;

  // 按住状态机
  var hold = null;          // { dx, dy, nextAt }
  var pressedKeys = [];     // 当前按住的键，按先后顺序

  // ---- 敌人 / 血量 / QTE ----
  var ARROW = { up: '↑', right: '→', down: '↓', left: '←' };
  var enemies = [];         // { x,y(浮点格坐标) tx,ty(目标格) dir, rage, qteLockUntil }
  var effects = [];         // 敌人裂开的碎片动画
  var qte = null;           // { e, seq, idx, t0, ms }
  var qteWarn = null;       // { e, t0, ms }：「反击！」提醒阶段，敌我同样定住
  var qteGapUntil = 0;      // 两次判定之间的冷却
  var hp = CFG.HP_MAX;
  var invulnUntil = 0;      // 无敌帧到期时间
  var regenAt = 0;          // 下一颗心回满的时间点（0 = 没在回血）
  var lastFrameAt = 0;      // 上一帧时间戳（算敌人 dt 用）
  var rescueOn = false;     // 「救命」指引线是否打开
  var rescuePath = null;    // 从主人公到终点的格子序列

  // BFS 复用缓冲（追人找路 + 生成时算起点的路径距离）
  var bfsDist = new Int32Array(1);
  var bfsSeen = new Uint32Array(1);
  var bfsQueue = new Int32Array(1);
  var bfsGen = 0;

  // ==================== 尺寸 ====================
  // 换地图尺寸 = 换 N / MC / CELL / VIEW，并重建所有缓冲区
  // 换地图尺寸 = 换 N / MC / CELL / VIEW，并重建所有缓冲区。
  // mapSize 是「设置里的值」，N 是「当前生效的值」，这里把前者洗成合法值后同步过去。
  function applyMapSize(n) {
    mapSize = clamp(Math.round(n) || CFG.MAP_DEFAULT, CFG.MAP_MIN, CFG.MAP_MAX);
    N = mapSize;

    MC = Math.max(2, Math.floor((N - 2) / 2));
    CELL = clamp(Math.round(CFG.PIXEL_BUDGET / N), CFG.CELL_MIN, CFG.CELL_MAX);
    SIZE = N * CELL;
    VIEW = Math.min(N, CFG.VIEW_MAX);

    grid = new Uint8Array(N * N);
    explored = new Uint8Array(N * N);

    bgc.width = bgc.height = SIZE;
    fogc.width = fogc.height = SIZE;
    bx.imageSmoothingEnabled = false;
    fx.imageSmoothingEnabled = false;

    cv.width = cv.height = VIEW * CELL;
    ctx.imageSmoothingEnabled = false;

    // BFS 缓冲跟着地图尺寸重建；敌人和特效也跟着清空（尺寸一变就没意义了）
    var total = N * N;
    bfsDist = new Int32Array(total);
    bfsSeen = new Uint32Array(total);
    bfsQueue = new Int32Array(total);
    bfsGen = 0;
    enemies.length = 0;
    effects.length = 0;

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
    bx.fillStyle = grid[i] === 1 ? CFG.WALL : '#000000';
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
        a = explored[i] ? CFG.FOG_MEMORY * CFG.FOG_RIM_LIT : CFG.FOG_RIM_DARK;
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
    rebuildFog();      // 里面会先 clearRect 一遍
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

    // 底边要给 HUD（时间 / 步数）让位，否则箭头会压在步数上；
    // HUD 尺寸是 CSS 像素，按「画布像素 / 显示尺寸」换算到画布坐标。
    var cssW = stageCssW || vw;
    var hudSafe = hudCssH * (vw / cssW) + CELL * 0.2;
    var padSide = CELL * CFG.HINT_PAD;
    var padB = padSide + hudSafe;

    var tx = dx > 0 ? (vw - padSide - cx) / dx : (dx < 0 ? (padSide - cx) / dx : Infinity);
    var ty = dy > 0 ? (vw - padB - cy) / dy : (dy < 0 ? (padSide - cy) / dy : Infinity);
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
    // 无敌帧：半透明闪烁，配合画面红角一眼看出还在保护期内
    if (now < invulnUntil) ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(now / 70));
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
    return pad2(Math.floor(ms / 60000)) + ':' +
           pad2(Math.floor((ms % 60000) / 1000)) + '.' +
           pad2(Math.floor((ms % 1000) / 10));
  }

  // ==================== 主循环 ====================
  // 一帧 = update（只改状态）+ draw（只读状态画图）。
  // render 外面套 try：某一帧画崩了也不会把动画循环打死（否则画面会永久停住，
  // 表现就是"人能动、但画面不动/全黑"）。
  var renderErrorLogged = false;

  function render(now) {
    try {
      update(now);
      draw(now);
    } catch (e) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        try { console.error('[迷宫] 渲染异常（已自动降级，循环继续）:', e); } catch (e2) {}
      }
    }
    requestAnimationFrame(render);
  }

  function update(now) {
    // 自愈：已经进入游玩态却还挂着生成遮罩（任何异常导致的"黑屏"）→ 立刻解除
    if (state === ST.PLAYING && curOverlay === ovGen) showOnly(null);

    // 敌人用 dt 走浮点速度；切后台回来时 dt 会很大，卡在 70ms 防瞬移
    var dt = lastFrameAt ? clamp(now - lastFrameAt, 0, 70) : 16;
    lastFrameAt = now;

    tickEffects(now);      // 裂开动画不跟游戏状态走，放完为止

    if (state !== ST.PLAYING) return;

    // 指引线的起点永远在脚下：位置一变就重算（走一步、传送都能跟上）
    if (rescueOn && rescuePath && rescuePath[0] !== py * N + px) buildRescuePath();

    if (qteWarn) {
      // 提醒中：「反击！」这 1 秒敌我都不动，只走提示条倒计时
      tickWarn(now);
    } else if (qte) {
      // 判定中：敌人和主人公都不动，只走倒计时
      tickQte(now);
    } else {
      // 按住连发：按下即走，之后每 STEP_MS 一格（不用系统按键重复）
      if (hold) {
        var guard = 0;
        while (now >= hold.nextAt && guard++ < CFG.STEP_MAX_CATCHUP) {
          tryMove(hold.dx, hold.dy);
          hold.nextAt += CFG.STEP_MS;
          if (state !== ST.PLAYING) break;
        }
      }
      if (state === ST.PLAYING) {
        moveEnemies(dt);
        tickRegen(now);
        checkContact(now);                       // 可能直接判负
        if (state === ST.PLAYING) tryTriggerQte(now);
      }
    }

    hudTime.textContent = fmt(now - startTime);
  }

  // 迷雾层：进迷宫就整片覆盖，不做「先亮一下再淡入」。
  // 只给主角身周留一块视野，其余全靠走。
  function drawFog(vw) {
    ctx.drawImage(fogc, camX * CELL, camY * CELL, vw, vw, 0, 0, vw, vw);

    // 硬保险：不论迷雾层出了什么问题，主角身周这块永远重新贴回底图，
    // 保证「视野」不可能被迷雾整个吃掉（黑屏的最后一道防线）
    var area = Math.min(SIZE, (CFG.FOG_R * 2 + 1) * CELL);
    if (area <= 0) return;
    var wx = clamp((px - CFG.FOG_R) * CELL, 0, SIZE - area);
    var wy = clamp((py - CFG.FOG_R) * CELL, 0, SIZE - area);
    ctx.drawImage(bgc, wx, wy, area, area, wx - camX * CELL, wy - camY * CELL, area, area);
  }

  // 出口红格只有「真的被照亮」时才画：迷雾里不许透出来指路
  function exitVisible() {
    if (exitI < 0) return false;
    if (!fogOn) return true;
    var ex = exitI % N, ey = (exitI / N) | 0;
    return Math.max(Math.abs(ex - px), Math.abs(ey - py)) <= CFG.FOG_R;
  }

  // 只画不改状态：所有绘制都在这里，顺序 = 图层顺序
  function draw(now) {
    var vw = VIEW * CELL;
    var canDraw = SIZE > 0 && vw > 0;

    if (state === ST.GENERATING) {
      // 生成阶段：迷雾关时把整张图缩进窗口，看得到全局开凿过程；
      // 迷雾开就什么都不画 —— 否则这一屏就把整张地图剧透了，迷雾等于白开。
      if (canDraw && !fogOn) ctx.drawImage(bgc, 0, 0, SIZE, SIZE, 0, 0, vw, vw);
    } else if (canDraw) {
      ctx.drawImage(bgc, camX * CELL, camY * CELL, vw, vw, 0, 0, vw, vw);
      if (fogOn && inGame()) drawFog(vw);
    }

    if (exitI >= 0 && inGame()) {
      drawRescue(now);                 // 救命白线：当地面标线，压在出口下面
      if (hintOn) drawExitHint(now);   // 出口在视野外 → 边缘箭头（开关关闭时不画）
      if (exitVisible()) drawExit(now);// 红格本体：迷雾开着时要走到眼前才看得见
      drawEnemies(now);                // 敌人：被迷雾挡住的不画
      drawEffects(now);                // 裂开的碎片
      drawPlayer(now);
      drawHurt(now);                   // 掉血后的红色暗角
    }
  }

  // 无敌帧期间给画面加一圈红色暗角，明确「刚被撞了」
  function drawHurt(now) {
    if (now >= invulnUntil) return;
    var vw = VIEW * CELL;
    var t = (invulnUntil - now) / CFG.INVULN_MS;
    var g = ctx.createRadialGradient(vw / 2, vw / 2, vw * 0.3, vw / 2, vw / 2, vw * 0.72);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, 'rgba(255,0,0,' + (0.34 * t).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vw);
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

  // 调试接口：只读状态 + 两个测试用动作（tp 传送、hurt 直接扣血）。
  // 正常玩法完全不依赖这里，删掉整块游戏也照跑。
  window.MazeDebug = {
    get state() { return state; },
    get hp() { return hp; },
    get enemies() { return enemies; },
    get qte() { return qte; },
    get warn() { return qteWarn; },
    get gap() { return qteGapUntil; },
    get invulnLeft() { return Math.round(invulnUntil - performance.now()); },
    get rescue() { return { on: rescueOn, len: rescuePath ? rescuePath.length : 0, path: rescuePath }; },
    get pos() { return [px, py]; },
    get exit() { return exitI; },
    get mapSize() { return N; },
    get cam() { return [camX, camY, VIEW]; },
    get invuln() { return invulnUntil; },
    enemyCount: function () { return enemyCount(N); },
    los: function (ax, ay, bx, by) { return hasLineOfSight(ax, ay, bx, by); },
    cell: function (x, y) { return (x < 0 || y < 0 || x >= N || y >= N) ? 1 : grid[y * N + x]; },
    dist: function (ax, ay, bx, by) {
      bfsFrom(ax, ay);
      var i = by * N + bx;
      return (i >= 0 && i < N * N && bfsSeen[i] === bfsGen) ? bfsDist[i] : -1;
    },
    tp: function (x, y) { px = x; py = y; clampCam(); rebuildFog(); },
    hurt: function () { damagePlayer(performance.now()); }
  };

  // ==================== 敌人 ====================
  // 样子：红边白格 + 中心黑格（面积占整格 1/3，像一只眼球）。
  // 行为：平时按「主人公按住移动键时速度的一半」在通路里游荡、不追人；
  //       QTE 失败后进入「狂暴」，速度升到 2/3 并开始 BFS 追人（不会穿墙）。
  function playerSpeed() { return 1 / CFG.STEP_MS; }   // 格 / 毫秒

  // 30~39 → 1 个，40~49 → 2 个 …… 90 及以上封顶 7 个
  function enemyCount(n) {
    return Math.min(CFG.ENEMY_MAX, 1 + Math.floor((n - CFG.MAP_MIN) / CFG.ENEMY_STEP));
  }

  // 从某格开始 BFS，把距离写进 bfsDist；bfsSeen 里存「第几代」代替每次清零
  function bfsFrom(sx, sy) {
    bfsGen++;
    if (bfsGen > 4000000000) { bfsSeen.fill(0); bfsGen = 1; }
    var g = bfsGen;
    var total = N * N;
    var s = sy * N + sx;
    if (s < 0 || s >= total || grid[s] === 1) return;

    var head = 0, tail = 0;
    bfsSeen[s] = g; bfsDist[s] = 0; bfsQueue[tail++] = s;
    while (head < tail) {
      var cur = bfsQueue[head++];
      var cx = cur % N, cy = (cur / N) | 0, d = bfsDist[cur];
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        var ni = ny * N + nx;
        if (grid[ni] === 1 || bfsSeen[ni] === g) continue;
        bfsSeen[ni] = g; bfsDist[ni] = d + 1; bfsQueue[tail++] = ni;
      }
    }
  }

  // 从目标反向 BFS，取起点四邻里离目标最近的那一步
  function bfsStep(sx, sy, gx, gy) {
    if (sx === gx && sy === gy) return null;
    bfsFrom(gx, gy);
    var best = null, bestD = 1e9;
    for (var k = 0; k < 4; k++) {
      var nx = sx + DIRS[k][0], ny = sy + DIRS[k][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      var ni = ny * N + nx;
      if (grid[ni] === 1 || bfsSeen[ni] !== bfsGen) continue;
      if (bfsDist[ni] < bestD) { bestD = bfsDist[ni]; best = [nx, ny]; }
    }
    return best;
  }

  // 挑「终点附近、但离起点足够远」的通路格当刷怪点。
  // 两道距离门槛都是为了「别一开局就遇上」：路径距离够长 + 不在起点眼皮底下。
  function collectSpawnCells() {
    bfsFrom(1, 1);                     // 起点 (1,1)

    var maxD = 0;
    for (var i = 0; i < N * N; i++) {
      if (bfsSeen[i] === bfsGen && bfsDist[i] > maxD) maxD = bfsDist[i];
    }
    var minD = Math.max(CFG.ENEMY_MIN_DIST, Math.round(maxD * 0.4));
    if (minD > maxD) minD = Math.round(maxD * 0.6);

    var ex = exitI % N, ey = (exitI / N) | 0;
    var cand = [];
    var R = CFG.ENEMY_EXIT_R;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        var x = ex + dx, y = ey + dy;
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        if (Math.abs(x - 1) + Math.abs(y - 1) < 8) continue;
        var idx = y * N + x;
        if (grid[idx] !== 0) continue;
        if (bfsSeen[idx] !== bfsGen || bfsDist[idx] < minD) continue;
        cand.push([x, y]);
      }
    }

    // 终点周围被墙挤得太干净时退一步：全图挑「离起点足够远」的通路格
    if (!cand.length) {
      var far = Math.max(6, Math.round(maxD * 0.5));
      for (var j = 0; j < N * N; j++) {
        if (grid[j] !== 0) continue;
        if (bfsSeen[j] !== bfsGen || bfsDist[j] < far) continue;
        cand.push([j % N, (j / N) | 0]);
      }
    }
    if (!cand.length) cand.push([ex, ey]);

    // 打乱：位置随机，但仍然都在终点附近
    for (var k = cand.length - 1; k > 0; k--) {
      var r = (Math.random() * (k + 1)) | 0;
      var t = cand[k]; cand[k] = cand[r]; cand[r] = t;
    }
    return cand;
  }

  // 在终点附近放怪：数量随地图变大，位置从候选格里随机取
  function spawnEnemies() {
    enemies.length = 0;
    effects.length = 0;
    if (exitI < 0) return;

    var cand = collectSpawnCells();
    var cnt = enemyCount(N);
    for (var c = 0; c < cnt; c++) {
      var cell = cand[c % cand.length];
      enemies.push({
        x: cell[0], y: cell[1], tx: cell[0], ty: cell[1],
        dir: null, rage: false, qteLockUntil: 0
      });
    }
  }

  // 每格中心到下一格中心，只在通路里走；到格心才重新选方向
  function pickNextCell(e) {
    var cx = Math.round(e.x), cy = Math.round(e.y);
    var opts = [];
    for (var k = 0; k < 4; k++) {
      var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (grid[ny * N + nx] === 1) continue;
      opts.push([nx, ny]);
    }
    if (!opts.length) return null;

    if (e.rage) {
      var step = bfsStep(cx, cy, px, py);
      if (step) { e.dir = [step[0] - cx, step[1] - cy]; return step; }
    }

    // 巡游：尽量不原路折返，只有死路才回头
    var fresh = [];
    if (e.dir) {
      for (var m = 0; m < opts.length; m++) {
        if (!(opts[m][0] === cx - e.dir[0] && opts[m][1] === cy - e.dir[1])) fresh.push(opts[m]);
      }
    }
    var pool = fresh.length ? fresh : opts;
    var pick = pool[(Math.random() * pool.length) | 0];
    e.dir = [pick[0] - cx, pick[1] - cy];
    return pick;
  }

  // 按「格 / 毫秒」推进：到格心才重新选方向，所以永远不会穿墙
  function moveEnemies(dt) {
    var ps = playerSpeed();
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      var left = ps * (e.rage ? CFG.ENEMY_RAGE : CFG.ENEMY_ROAM) * dt;
      var guard = 0;   // 兜底：一帧最多处理 16 段，防极端 dt 下的死循环
      while (left > 1e-9 && guard++ < 16) {
        if (Math.abs(e.x - e.tx) < 1e-6 && Math.abs(e.y - e.ty) < 1e-6) {
          e.x = e.tx; e.y = e.ty;
          var nxt = pickNextCell(e);
          if (!nxt) break;
          e.tx = nxt[0]; e.ty = nxt[1];
        }
        var dx = e.tx - e.x, dy = e.ty - e.y;
        var dist = Math.abs(dx) + Math.abs(dy);
        if (dist <= left) {
          e.x = e.tx; e.y = e.ty;
          left -= dist;
        } else {
          e.x += (dx > 0 ? left : dx < 0 ? -left : 0);
          e.y += (dy > 0 ? left : dy < 0 ? -left : 0);
          left = 0;
        }
      }
    }
  }

  // 单格是否在「视野」里：迷雾下是照亮半径，无迷雾下是摄像机窗口
  function cellLit(ex, ey) {
    if (ex < camX || ex >= camX + VIEW || ey < camY || ey >= camY + VIEW) return false;
    if (!fogOn) return true;
    return Math.max(Math.abs(ex - px), Math.abs(ey - py)) <= CFG.FOG_R;
  }

  // 敌人正压在哪几格：停在格心时 1 格；跨格途中压着前后两格
  function enemyCells(e) {
    var ax = Math.round(e.x), ay = Math.round(e.y);
    var bx = Math.floor(e.x), by = Math.floor(e.y);
    if (ax === bx && ay === by) return [[ax, ay]];
    return [[ax, ay], [bx, by]];
  }

  // 画不画：按它所在的主格判断（被迷雾挡住的敌人不画）
  function enemyLit(e) {
    return cellLit(clamp(Math.round(e.x), 0, N - 1), clamp(Math.round(e.y), 0, N - 1));
  }

  // QTE 触发范围：有迷雾 = 照亮半径（就是玩家能看见的视野）；
  // 无迷雾时整屏都算可见，但一屏可能有几十格，所以只认 6 格内的「对上眼」。
  // 额外要求「同一条直走廊、中间没有墙」——隔着墙也能判定太反直觉。
  function hasLineOfSight(ax, ay, bx, by) {
    if (ax !== bx && ay !== by) return false;      // 不在同一行/列：隔着拐角，不算
    if (ax === bx && ay === by) return true;
    var i;
    if (ax === bx) {
      var sy = by > ay ? 1 : -1;
      for (i = ay + sy; i !== by; i += sy) if (grid[i * N + ax] === 1) return false;
    } else {
      var sx = bx > ax ? 1 : -1;
      for (i = ax + sx; i !== bx; i += sx) if (grid[ay * N + i] === 1) return false;
    }
    return true;
  }

  function cellInQteRange(ex, ey) {
    var d = Math.max(Math.abs(ex - px), Math.abs(ey - py));
    if (fogOn) {
      if (d > CFG.FOG_R) return false;
    } else if (d > CFG.QTE_RANGE || !cellLit(ex, ey)) {
      return false;
    }
    return hasLineOfSight(ex, ey, px, py);
  }

  // 敌人跨在两格之间时，它压着的任意一格「同走廊」就算对上眼。
  // 只按 round() 取一格的话，它跨过格线的那一帧会突然变成「斜对角」，
  // 贴脸却不出判定——手感上非常像 bug。
  function enemyInQteRange(e) {
    var cs = enemyCells(e);
    for (var i = 0; i < cs.length; i++) {
      if (cellInQteRange(cs[i][0], cs[i][1])) return true;
    }
    return false;
  }

  function drawEnemy(e, now) {
    var x = (e.x - camX) * CELL, y = (e.y - camY) * CELL;
    var inset = Math.max(1, CELL * 0.04);
    var w = CELL - inset * 2;
    var k = 0.5 + 0.5 * Math.sin(now / (e.rage ? 110 : 280));

    // 白格本体（狂暴时带红光）
    ctx.save();
    if (e.rage) {
      ctx.shadowColor = 'rgba(255,30,30,' + (0.55 + 0.45 * k).toFixed(3) + ')';
      ctx.shadowBlur = CELL * (0.45 + 0.55 * k);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + inset, y + inset, w, w);
    ctx.restore();

    // 红边（细一点，留出「白格」的边，才像眼球）
    var lw = Math.max(1, CELL * 0.05);
    ctx.lineWidth = lw;
    ctx.strokeStyle = e.rage ? '#ff1010' : '#e02323';
    ctx.strokeRect(x + inset + lw / 2, y + inset + lw / 2, w - lw, w - lw);

    // 中心黑格：面积占整格 1/3 → 边长 = CELL / √3
    var bs = CELL / Math.sqrt(3);
    var ox = x + (CELL - bs) / 2, oy = y + (CELL - bs) / 2;
    ctx.fillStyle = '#000000';
    ctx.fillRect(ox, oy, bs, bs);

    // 黑格里一点红光，看着像活物
    if (bs > 6) {
      var dot = Math.max(1, bs * 0.17);
      ctx.fillStyle = 'rgba(255,45,45,' + (0.3 + 0.55 * k).toFixed(3) + ')';
      ctx.fillRect(ox + bs * 0.3, oy + bs * 0.3, dot, dot);
    }
  }

  function drawEnemies(now) {
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!enemyLit(e)) continue;
      drawEnemy(e, now);
    }
  }

  // ==================== 敌人裂开 ====================
  function spawnCrack(x, y, now) {
    var parts = [];
    for (var i = 0; i < 10; i++) {
      var a = (i / 10) * Math.PI * 2 + Math.random() * 0.5;
      var sp = 1.4 + Math.random() * 2.6;
      parts.push({
        ax: Math.cos(a) * sp, ay: Math.sin(a) * sp,
        w: 0.09 + Math.random() * 0.15, h: 0.09 + Math.random() * 0.2,
        rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 14,
        c: i % 4 === 0 ? '#000000' : (i % 4 === 1 ? '#ff2d2d' : '#ffffff')
      });
    }
    effects.push({ x: x, y: y, t0: now, parts: parts });
  }

  function tickEffects(now) {
    for (var i = effects.length - 1; i >= 0; i--) {
      if (now - effects[i].t0 > CFG.CRACK_MS) effects.splice(i, 1);
    }
  }

  function drawEffects(now) {
    for (var i = 0; i < effects.length; i++) {
      var ef = effects[i];
      var t = (now - ef.t0) / CFG.CRACK_MS;
      if (t < 0 || t > 1) continue;
      var ease = 1 - Math.pow(1 - t, 2.2);
      var cx0 = (ef.x - camX) * CELL + CELL / 2;
      var cy0 = (ef.y - camY) * CELL + CELL / 2;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      for (var j = 0; j < ef.parts.length; j++) {
        var p = ef.parts[j];
        ctx.save();
        ctx.translate(cx0 + p.ax * CELL * ease, cy0 + p.ay * CELL * ease);
        ctx.rotate(p.rot + p.spin * t * 0.2);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w * CELL / 2, -p.h * CELL / 2, p.w * CELL, p.h * CELL);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ==================== QTE ====================
  function buildQteKeys() {
    qteKeys.innerHTML = '';
    for (var i = 0; i < qte.seq.length; i++) {
      if (i) {
        var sep = document.createElement('span');
        sep.className = 'qkey-sep';
        sep.textContent = '›';
        qteKeys.appendChild(sep);
      }
      var k = document.createElement('span');
      k.className = 'qkey' + (i === 0 ? ' next' : '');
      k.textContent = ARROW[qte.seq[i]];
      qteKeys.appendChild(k);
    }
  }

  function setQteBar(p) { qteBar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; }

  // ---- 「反击！」提醒（1 秒）：先定住，让玩家反应过来，再进正式判定 ----
  function showWarn() {
    warnBox.classList.add('show');
    warnBox.setAttribute('aria-hidden', 'false');
    setWarnBar(1);
  }
  function hideWarn() {
    warnBox.classList.remove('show');
    warnBox.setAttribute('aria-hidden', 'true');
    setWarnBar(0);
  }
  function setWarnBar(p) { warnBar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; }
  function clearWarn() { qteWarn = null; hideWarn(); }

  function startWarn(e, now) {
    qteWarn = { e: e, t0: now, ms: CFG.QTE_WARN_MS };
    hold = null;                     // 提醒期间也不动
    pressedKeys.length = 0;
    showWarn();
    beep(392, 0.1, 'square', 0.05);
    setTimeout(function () { beep(523, 0.1, 'square', 0.05); }, 110);
  }

  function tickWarn(now) {
    var left = qteWarn.t0 + qteWarn.ms - now;
    if (left > 0) { setWarnBar(left / qteWarn.ms); return; }
    var e = qteWarn.e;
    clearWarn();
    // 定住的这 1 秒里敌人不可能走开，这里再校一次只是保险
    if (enemies.indexOf(e) >= 0 && enemyInQteRange(e)) startQte(e, now);
  }

  function startQte(e, now) {
    // 从四个方向里不重复地抽 CFG.QTE_KEYS 个（默认 2 个，看得更清）
    var pool = ['up', 'right', 'down', 'left'];
    var seq = [];
    var n = clamp(CFG.QTE_KEYS, 1, pool.length);
    for (var i = 0; i < n; i++) seq.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
    qte = { e: e, seq: seq, idx: 0, t0: now, ms: CFG.QTE_MS };

    hold = null;                 // 判定期间主人公平移停止，松开状态机
    pressedKeys.length = 0;
    buildQteKeys();
    qteBox.classList.add('show');
    qteBox.setAttribute('aria-hidden', 'false');
    setQteBar(1);
    qteNum.textContent = (CFG.QTE_MS / 1000).toFixed(1) + 's';

    beep(1046, 0.06, 'square', 0.04);
    setTimeout(function () { beep(1318, 0.07, 'square', 0.04); }, 90);
  }

  function closeQte() {
    qte = null;
    qteBox.classList.remove('show');
    qteBox.setAttribute('aria-hidden', 'true');
    setQteBar(0);
    qteGapUntil = performance.now() + CFG.QTE_GAP_MS;
    hold = null;
  }

  function tickQte(now) {
    var left = qte.t0 + qte.ms - now;
    if (left <= 0) { qteFail(); return; }
    setQteBar(left / qte.ms);
    var s = (left / 1000).toFixed(1) + 's';
    if (qteNum.textContent !== s) qteNum.textContent = s;
  }

  // 判定中按方向键：按顺序来，按错 / 多按都算失败
  function qtePress(name) {
    if (!qte) return;
    if (name !== qte.seq[qte.idx]) { qteFail(); return; }
    var cells = qteKeys.children;
    qte.idx++;
    // 更新两个键的样式：已按完的变绿，下一个高亮
    for (var i = 0, ci = 0; i < cells.length; i++) {
      if (!cells[i].classList.contains('qkey')) continue;
      cells[i].classList.toggle('done', ci < qte.idx);
      cells[i].classList.toggle('next', ci === qte.idx);
      ci++;
    }
    if (qte.idx >= qte.seq.length) { qteSuccess(); return; }
    beep(760, 0.05, 'square', 0.035);
  }

  function qteSuccess() {
    var e = qte.e;
    var now = performance.now();
    spawnCrack(e.x, e.y, now);          // 裂开消失
    var i = enemies.indexOf(e);
    if (i >= 0) enemies.splice(i, 1);
    closeQte();
    beep(880, 0.08, 'square', 0.05);
    setTimeout(function () { beep(1174, 0.1, 'square', 0.05); }, 80);
    setTimeout(function () { beep(1568, 0.14, 'square', 0.045); }, 170);
  }

  function qteFail() {
    var e = qte.e;
    var now = performance.now();
    e.rage = true;                              // 加速 + 开始追人
    e.qteLockUntil = now + CFG.QTE_LOCK_MS;     // 1.5 秒内不能再判定
    closeQte();
    beep(140, 0.26, 'sawtooth', 0.06);
    setTimeout(function () { beep(90, 0.3, 'sawtooth', 0.05); }, 120);
  }

  function tryTriggerQte(now) {
    if (qte || qteWarn || now < qteGapUntil) return;
    var best = null, bestD = 1e9;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (now < e.qteLockUntil) continue;
      if (!enemyInQteRange(e)) continue;
      var d = Math.abs(e.x - px) + Math.abs(e.y - py);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) startWarn(best, now);
  }

  // ==================== 血量 ====================
  // 一整局的战斗状态：敌人、判定、血量、救命线、帧计时，全部清零。
  // 进新局和回开始界面要做的清理完全一样，所以只留这一个入口。
  function resetCombat() {
    enemies.length = 0;
    effects.length = 0;
    qte = null;
    qteGapUntil = 0;
    qteBox.classList.remove('show');
    qteBox.setAttribute('aria-hidden', 'true');
    clearWarn();
    hp = CFG.HP_MAX;
    invulnUntil = 0;
    regenAt = 0;
    rescueOn = false;
    rescuePath = null;
    lastFrameAt = 0;
  }

  function syncHearts() {
    heartsBox.classList.toggle('live', inGame());
    heartsBox.setAttribute('aria-label', '生命值 ' + Math.max(0, hp) + ' / ' + CFG.HP_MAX);
    for (var i = 0; i < heartsBox.children.length; i++) {
      heartsBox.children[i].classList.toggle('off', i >= hp);
    }
  }

  function checkContact(now) {
    if (now < invulnUntil) return;              // 无敌帧
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (Math.abs(e.x - px) < CFG.ENEMY_HIT_R && Math.abs(e.y - py) < CFG.ENEMY_HIT_R) {
        damagePlayer(now);
        return;
      }
    }
  }

  function damagePlayer(now) {
    hp--;
    invulnUntil = now + CFG.INVULN_MS;
    regenAt = now + CFG.REGEN_MS;               // 回血从掉血这一刻重新计时
    syncHearts();
    beep(110, 0.2, 'sawtooth', 0.07);
    if (hp <= 0) loseGame();
  }

  // 满 8 秒回一颗心，回满为止
  function tickRegen(now) {
    if (hp <= 0 || hp >= CFG.HP_MAX) { regenAt = 0; return; }
    if (!regenAt) regenAt = now + CFG.REGEN_MS;
    if (now < regenAt) return;
    hp++;
    syncHearts();
    beep(880, 0.1, 'sine', 0.045);
    regenAt = hp < CFG.HP_MAX ? now + CFG.REGEN_MS : 0;
  }

  function loseGame() {
    hp = 0;
    state = ST.LOSE;
    hold = null;
    pressedKeys.length = 0;
    if (qte) closeQte();
    clearWarn();
    syncHearts();

    var spend = performance.now() - startTime;
    loseTime.textContent = fmt(spend);
    loseSteps.textContent = steps;
    hud.classList.remove('show');
    showOnly(ovLose);

    [330, 262, 196].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.22, 'triangle', 0.055); }, i * 150);
    });
  }

  // ==================== 救命指引 ====================
  // 从主人公所在格 BFS 到终点，回溯出一条格子序列，然后画成白线。
  // 迷雾模式下只在「照亮范围」内可见（用照亮格拼成裁剪区），不给透视。
  function buildRescuePath() {
    if (state !== ST.PLAYING || exitI < 0) { rescuePath = null; return; }
    var s0 = py * N + px;
    if (s0 === exitI) { rescuePath = null; return; }

    bfsFrom(px, py);
    if (bfsSeen[exitI] !== bfsGen) { rescuePath = null; return; }

    var path = [];
    var cur = exitI, guard = 0;   // guard：兜底，正常一定会先回到起点
    while (cur !== s0 && guard++ < N * N) {
      path.push(cur);
      var cx = cur % N, cy = (cur / N) | 0, d = bfsDist[cur];
      var nxt = -1;
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        var ni = ny * N + nx;
        if (grid[ni] === 1 || bfsSeen[ni] !== bfsGen) continue;
        if (bfsDist[ni] === d - 1) { nxt = ni; break; }
      }
      if (nxt < 0) break;
      cur = nxt;
    }
    path.push(s0);
    path.reverse();          // 改成「从主人公到终点」
    rescuePath = path;
  }

  function drawRescue(now) {
    if (!rescueOn || !rescuePath || rescuePath.length < 2) return;
    var i, ci, x0, y0;

    ctx.save();

    // 迷雾：把画布裁到「照亮范围」的这几格，线只在视野内出现
    if (fogOn) {
      ctx.beginPath();
      for (var gy = -CFG.FOG_R; gy <= CFG.FOG_R; gy++) {
        for (var gx = -CFG.FOG_R; gx <= CFG.FOG_R; gx++) {
          var wx = px + gx, wy = py + gy;
          if (wx < 0 || wy < 0 || wx >= N || wy >= N) continue;
          ctx.rect((wx - camX) * CELL, (wy - camY) * CELL, CELL, CELL);
        }
      }
      ctx.clip();
    }

    ctx.beginPath();
    for (i = 0; i < rescuePath.length; i++) {
      ci = rescuePath[i];
      x0 = (ci % N - camX) * CELL + CELL / 2;
      y0 = (((ci / N) | 0) - camY) * CELL + CELL / 2;
      if (i === 0) ctx.moveTo(x0, y0); else ctx.lineTo(x0, y0);
    }

    // 底下一层柔光，保证在绿墙和纯黑通路上都看得清
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = Math.max(2, CELL * 0.2);
    ctx.shadowColor = 'rgba(255,255,255,.9)';
    ctx.shadowBlur = CELL * 0.7;
    ctx.stroke();

    // 上面一层会往终点方向跑的虚线：不用箭头也知道往哪走
    var period = CELL * 0.78;
    ctx.setLineDash([CELL * 0.42, CELL * 0.36]);
    ctx.lineDashOffset = -((now / 26) % period);
    ctx.strokeStyle = 'rgba(255,255,255,.96)';
    ctx.lineWidth = Math.max(1.2, CELL * 0.1);
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  // 按钮只在「进了迷宫」时出现；离开游玩态就自动收线
  function syncRescue() {
    var live = state === ST.PLAYING;
    btnRescue.hidden = !live;
    if (!live) { rescueOn = false; rescuePath = null; }
    btnRescue.classList.toggle('on', rescueOn);
    btnRescue.setAttribute('aria-pressed', rescueOn ? 'true' : 'false');
    btnRescue.title = rescueOn ? '收起指引线' : '画一条通往终点的白线';
  }

  // ==================== 界面切换 ====================
  // 遮罩只有这一个开关入口：传 null 表示"全部收起"
  function showOnly(el) {
    OVERLAYS.forEach(function (o) {
      o.classList.toggle('show', o === el);
    });
    curOverlay = el;
    syncRestart();
    syncHearts();
    syncRescue();
  }

  // 「重新开始」常驻在音乐条上方：只在真的可以重开时才亮出来
  function syncRestart() {
    var can = state !== ST.START;
    btnRestart.disabled = !can;
    btnRestart.setAttribute('aria-hidden', can ? 'false' : 'true');
    btnRestart.title = can ? '放弃本局，回到开始界面' : '';
  }

  function setProgress(p, tip) {
    p = clamp(p, 0, 1);
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

    // 音乐条 + 工具条占掉的竖向空间（各含它与下一层之间的 8px 间距）
    var MB_GAP = 8;
    var mbH = (musicbar && !musicbar.hidden) ? (musicbar.offsetHeight + MB_GAP) : 0;
    var tbH = (toolbar && !toolbar.hidden) ? (toolbar.offsetHeight + MB_GAP) : 0;

    var availW = Math.max(0, wrap.clientWidth - padX - 2);
    var availH = Math.max(0, wrap.clientHeight - padY - 2 - mbH - tbH);

    if (land) {
      availW -= (side.offsetWidth + gap);
    } else {
      availH -= (side.offsetHeight + gap);
    }

    var s = Math.max(120, Math.min(availW, availH, 600));
    stage.style.width = s + 'px';
    stage.style.height = s + 'px';

    // 量一次真实尺寸供每帧绘制使用（此后绘制阶段不再碰 DOM 布局）
    stageCssW = Math.max(1, stage.clientWidth || 0);
    hudCssH = hud.offsetHeight || 0;

    // 舞台小的时候，遮罩里的内容收一档（否则设置面板会顶出画面，需要滚动）
    var compact = s < 430;
    OVERLAYS.forEach(function (o) {
      o.classList.toggle('compact', compact);
    });

    // 音乐条和画面同宽；画面越窄，条上的次要控件逐级收起来
    stagewrap.style.width = s + 'px';
    toolbar.style.width = s + 'px';
    musicbar.style.width = s + 'px';
    musicbar.classList.toggle('wide', s >= 420);
    musicbar.classList.toggle('compact', s < 320);
    musicbar.classList.toggle('tiny', s < 260);
  }

  // ==================== 迷宫生成 ====================
  // 生长树打通所有格子 → 完美迷宫（任意两格之间恰好一条路），出口必然可达。
  function beginGenerate() {
    state = ST.GENERATING;
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

  // 生长树（Growing Tree）：
  //   BRANCH_P=1 时每次都取「最近加入的格子」→ 等价于递归回溯，一条长廊；
  //   降低 BRANCH_P 就逐渐改成随机取活跃格 → 岔路越来越多、死路越来越短。
  // 这是唯一能在「格子全被用光」的格网上真正增加岔路的办法。
  function carveStep() {
    var st = gen.stack;
    if (!st.length) return;
    var idx = (Math.random() < CFG.BRANCH_P)
      ? st.length - 1
      : ((Math.random() * st.length) | 0);
    var cur = st[idx];
    var cx = cur[0], cy = cur[1];
    var opts = [];
    for (var d = 0; d < 4; d++) {
      var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= MC || ny >= MC) continue;
      if (gen.seen[ny * MC + nx]) continue;
      opts.push([nx, ny]);
    }
    if (opts.length === 0) { st.splice(idx, 1); return; }

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
      if (state !== ST.GENERATING || !gen) return;

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
          if (state === ST.GENERATING) enterMaze();
        }, CFG.GEN_DONE_MS);
      }
    } catch (e) {
      // 生成过程出任何异常，都不能把玩家关在加载界面里
      try { console.error('[迷宫] 生成异常:', e); } catch (e2) {}
      if (state === ST.GENERATING) {
        state = ST.START;
        gen = null;
        hud.classList.remove('show');
        showOnly(ovStart);
        genTip.textContent = '生成失败，请重试';
      }
      again = false;
    }
    if (again) requestAnimationFrame(genLoop);
  }

  // 从起点 BFS，取距离最远的通路格作为出口。
  // 复用 bfsFrom（全项目只保留这一份 BFS，别再写第二份）
  function findExit() {
    bfsFrom(1, 1);
    var best = 1 * N + 1, bestD = 0;
    for (var i = 0; i < N * N; i++) {
      if (bfsSeen[i] !== bfsGen) continue;
      if (bfsDist[i] > bestD) { bestD = bfsDist[i]; best = i; }
    }
    exitI = best;
  }

  // ==================== 游戏流程 ====================
  function enterMaze() {
    state = ST.PLAYING;
    px = 1; py = 1;
    steps = 0;
    startTime = performance.now();
    hold = null;
    pressedKeys.length = 0;
    resetCombat();
    spawnEnemies();      // 在终点附近放怪
    clampCam();
    resetFog();   // 迷雾立即生效：进来只剩身周一小块视野，整图不给看

    // 先解除遮罩再动别的 UI：万一后面任何一步出异常，也不会把画面锁在黑屏上
    showOnly(null);
    hud.classList.add('show');
    hudCssH = hud.offsetHeight || 0;      // HUD 这时才真的可见，补量一次
    stageCssW = Math.max(1, stage.clientWidth || stageCssW);
    hudFog.hidden = !fogOn;
    hudSteps.textContent = '0 步';
    hudTime.textContent = '00:00.00';
    syncHearts();

    beep(660, 0.09, 'triangle', 0.05);
    setTimeout(function () { beep(880, 0.1, 'triangle', 0.04); }, 90);
  }

  function tryMove(dx, dy) {
    if (state !== ST.PLAYING) return;
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
    state = ST.WIN;
    hold = null;
    if (qte) closeQte();
    clearWarn();
    var spend = performance.now() - startTime;
    hudTime.textContent = fmt(spend);
    winTime.textContent = fmt(spend);
    winSteps.textContent = steps;
    hud.classList.remove('show');
    showOnly(ovWin);
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.16, 'triangle', 0.055); }, i * 105);
    });
  }

  // 把游戏状态彻底复位回「开始」界面。
  // 注意：这里不复位音乐模块 —— 它独立运行，重开一局不该打断正在放的音乐。
  function resetToStart() {
    state = ST.START;
    gen = null;
    hold = null;
    bump = null;
    pressedKeys.length = 0;
    exitI = -1;
    px = 1; py = 1;
    steps = 0;
    camX = 0; camY = 0;
    startTime = 0;
    renderErrorLogged = false;   // 复位渲染异常标记，重新给一次日志机会

    resetCombat();   // 敌人 / 判定 / 血量 / 救命线一并清掉

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
  // 键 → 方向名。判定（QTE）也要方向名，所以这张表存名字，坐标现查 DIR_BY_NAME。
  var KEYMAP = {
    w: 'up', a: 'left', s: 'down', d: 'right',
    arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right'
  };

  function startHold(dx, dy) {
    if (qte || state !== ST.PLAYING) return;
    hold = { dx: dx, dy: dy, nextAt: performance.now() + CFG.STEP_MS };
    tryMove(dx, dy);          // 第一下立刻走
  }

  function stopHold() { hold = null; }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var key = e.key.toLowerCase();
    var name = KEYMAP[key];
    if (!name) return;
    e.preventDefault();
    if (e.repeat) return;                    // 系统重复一律不用
    // 判定中：方向键只喂给 QTE，人不动
    if (qte) { qtePress(name); return; }
    if (state !== ST.PLAYING) return;
    if (pressedKeys.indexOf(key) < 0) pressedKeys.push(key);
    var d = DIR_BY_NAME[name];
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
      var lastName = last ? KEYMAP[last] : null;
      if (lastName && !qte && state === ST.PLAYING) {
        var d = DIR_BY_NAME[lastName];
        hold = { dx: d[0], dy: d[1], nextAt: performance.now() + CFG.STEP_MS };
      } else {
        hold = null;
      }
    }
  });

  window.addEventListener('blur', function () { pressedKeys.length = 0; hold = null; });

  // 虚拟方向键：与键盘共用同一套状态机；判定中同样改成喂 QTE
  Array.prototype.forEach.call(pad.querySelectorAll('button'), function (b) {
    var dname = b.getAttribute('data-dir');
    b.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      ensureAudio();
      if (qte) { qtePress(dname); return; }
      var dir = DIR_BY_NAME[dname];
      startHold(dir[0], dir[1]);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      b.addEventListener(t, stopHold);
    });
    b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  });
  window.addEventListener('pointerup', stopHold);

  // ==================== 按钮 ====================
  btnStart.addEventListener('click', function () {
    ensureAudio();
    state = ST.SETUP;
    showOnly(ovSetup);
  });

  btnEnter.addEventListener('click', function () {
    ensureAudio();
    beginGenerate();
  });

  btnBack.addEventListener('click', function () {
    state = ST.START;
    showOnly(ovStart);
  });

  btnRestart.addEventListener('click', function () {
    if (state === ST.START) return;      // 已经在开始界面，点了也不该有动作
    ensureAudio();
    // 不再整页刷新：刷新会把背景音乐一起打断，而且回来还要再点一次才有声。
    // 改成在内存里彻底复位，音乐模块独立运行，重开一局不打断它。
    resetToStart();
  });

  // 「救命」：开关指引线。只在迷宫里有效，离开游玩态自动收线
  btnRescue.addEventListener('click', function () {
    ensureAudio();
    if (state !== ST.PLAYING) return;
    rescueOn = !rescueOn;
    if (rescueOn) { buildRescuePath(); beep(880, 0.07, 'sine', 0.05); }
    else { rescuePath = null; beep(520, 0.05, 'sine', 0.035); }
    syncRescue();
  });

  // 失败结算里的「再来一局」：直接用当前设置重新生成一张图
  btnRetry.addEventListener('click', function () {
    ensureAudio();
    beginGenerate();
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
      localStorage.setItem('maze_hint', hintOn ? '1' : '0');
      localStorage.setItem('maze_vol', String(Math.round(masterVol * 100)));
    } catch (e) { /* 隐私模式或 file:// 下可能被拒，忽略即可 */ }
  }

  function renderSizeLabel() {
    sizeVal.textContent = mapSize + '×' + mapSize;
    sizeNote.hidden = mapSize <= CFG.VIEW_MAX;
  }

  // 终点指引只在「地图比画面大」时才有意义（小图整张都在画面里，出口必然可见）
  function renderHintRow() {
    var usable = mapSize > CFG.VIEW_MAX;
    hintField.classList.toggle('dim', !usable);
    if (!usable) {
      hintNote.hidden = false;
      hintNote.textContent = '整张迷宫都在画面内，出口必定可见';
    } else if (hintOn) {
      hintNote.hidden = false;
      hintNote.textContent = '出口不在画面内时，边缘出现呼吸红箭头';
    } else {
      hintNote.hidden = true;
    }
  }

  sizeRange.addEventListener('input', function () {
    mapSize = clamp(parseInt(sizeRange.value, 10) || CFG.MAP_DEFAULT, CFG.MAP_MIN, CFG.MAP_MAX);
    renderSizeLabel();
    renderHintRow();
  });
  // 松手才写 localStorage：拖动时每个 input 都同步写盘会卡手
  sizeRange.addEventListener('change', function () {
    ensureAudio();
    saveSettings();
    beep(700, 0.05, 'sine', 0.03);
  });

  fogChk.addEventListener('change', function () {
    ensureAudio();
    fogOn = !!fogChk.checked;
    if (state === ST.PLAYING) resetFog();
    saveSettings();
    beep(780, 0.05, 'sine', 0.03);
  });

  hintChk.addEventListener('change', function () {
    ensureAudio();
    hintOn = !!hintChk.checked;
    renderHintRow();
    saveSettings();
    beep(hintOn ? 880 : 520, 0.05, 'sine', 0.03);
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
      var h = localStorage.getItem('maze_hint');
      hintOn = (h === null || h === '') ? CFG.HINT_DEFAULT : (h === '1');
      var v = localStorage.getItem('maze_vol');
      setVol(v === null || v === '' ? CFG.VOL_DEFAULT : parseFloat(v));
    } catch (e) {
      mapSize = CFG.MAP_DEFAULT;
      hintOn = CFG.HINT_DEFAULT;
      setVol(CFG.VOL_DEFAULT);
    }
    sizeRange.value = mapSize;
    fogChk.checked = fogOn;
    hintChk.checked = hintOn;
    renderSizeLabel();
    renderHintRow();
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
  syncRestart();          // 开局就在开始界面 → 工具条上的重开按钮先藏起来
  syncRescue();           // 「救命」同理：没进迷宫不该出现
  requestAnimationFrame(render);
})();
