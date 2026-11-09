/* ============================================================
   迷宫寻路 · 像素迷宫  —  游戏逻辑
   原生 Canvas 2D，无依赖。单文件闭包，不污染全局。
   对外只暴露两个东西：MazeAudio（给音乐模块复用 AudioContext）、
   MazeDebug（只给自动化测试 / 控制台排查用，正常玩法不依赖它）。
   路线总结是独立模块 maze-route.js：本文件只通过 window.MazeRoute 递一份快照，
   不引用它的内部实现（maze-route.js 在本文件之前加载）。

   结构（自上而下就是执行顺序）：
     CFG                       所有可调参数（想改手感只动这里）
     ST / DIRS / 尺寸变量      状态机取值、方向表、当前地图尺寸
     小工具 / DOM / 状态       只有这里碰 document
     applyMapSize / fit        尺寸与自适应
     render / update / draw    一帧 = 先算状态，再画画（两者不混）
     敌人 / QTE / 血量 / 救命   对抗系统，四个小节各自成组，互不越界
     界面切换 / 生成 / 流程     遮罩、迷宫生成、开局与结算
     路线总结 / 结算            有序轨迹、BFS 正确路线、交给 MazeRoute 的快照
     颜色 / 输入 / 设置         交互与持久化

   · 迷宫：生长树（Growing Tree）生成完美迷宫；出口 = 距起点 BFS 最远的通路格，
     必然可通关。CFG.BRANCH_P 控制岔路密度（1 = 一条长廊，越小岔路越多）。
   · 尺寸：地图边长 30~100 可调；超过 VIEW_MAX 时开摄像机窗口跟随主角，
     保证任何尺寸下每格在屏幕上都是同样大小。
   · 迷雾：视野 = 四条正交直线（遇墙即止、墙本身可见）+ 直线通路格的一层四邻
     （路口一瞥 / 墙轮廓）。由 lit 统一提供，敌人显隐、出口、救命线全查它；
     QTE 在 lit 之上还要求「同一条直走廊」（贴脸 1 格例外），见 cellInQteRange。
     雾层只有三档：视野内挖空露底图、外圈 FOG_FADE_RINGS 格填统一浅黑（含走过的残影）、
     其余纯黑；浅黑是不透明中性色，不透视地形，墙那一侧依旧全黑。
     通路底色故意不设为黑，视野边界才看得出来。
   · 输入：自建按住状态机，按下即走，按住按 STEP_MS 固定节拍连走（不理系统重复延迟）。
   · 对抗：敌人总数 = 本局宝物数量（4 / 8 / 12，随地图变大），分配顺序固定不变：
     ① 终点附近必刷 1 只（固定 enemies[0]）；② 剩下的按「一个宝物 1 只」派到
     宝物附近（沿路径距离，不穿墙、不压宝物），名额用完即止；③ 宝物周围没落脚点时
     剩余名额退回终点附近。终点占掉 1 个名额，所以**恰好有一个宝物没有守卫**。
     敌人外观 = 「红边白格 + 黑瞳」，平时按主人公一半速度游荡、不追人。
     迷雾下要「落在视野内 + 和主人公在同一条直走廊上」（贴脸 1 格例外，避免拐角侧格提前判定）；
     无迷雾时另要求 **同一条直走廊、中间无墙**（hasLineOfSight）且在 QTE_RANGE 格内
     → 先定住闪 1 秒「反击！」→ 再弹 QTE（两个方向键 + 1.8 秒
     倒计时）。按对 → 裂开消失；按错/超时/多按 → 变红加速到 2/3 速度追人，1.5 秒后
     若仍在视野里可以再判。被撞掉一颗心，0.8 秒无敌帧，8 秒回一颗，三颗掉光即失败。
   · 宝物：只放在「岔路尽头」（开口邻居 == 1 的通路格），数量按边长阶梯 4 / 8 / 12，
     正负面标记预分配成 3:1（正面:负面）且负面至少 1 个，收集时才随机抽具体能力。
     外观 = 主人公同色方块 + 黄色泛光边；迷雾下和敌人/出口一样只画在 lit 里，
     例外是「双生信标」（全图常亮）与「隔墙之眼」（它挖开的那一片里，地形、宝物、
     敌人、终点红格一起可见）。正面能力只在迷雾模式出现（4 个视野增益），
     非迷雾模式换成「已用时间 −15 秒」；
     负面能力 3 个：随机传送 / 掉两颗心 / 身后刷一只敌人。视野增益只改雾层或实体显隐，
     不往 lit 里塞格子 —— lit 仍然是「能不能被直视」与 QTE 判定的唯一真源，
     隔墙看见的敌人不判定。
   ============================================================ */
(function () {
  'use strict';

  // 版本标记：更新后如果这里还是旧版本号，说明浏览器在用缓存
  var VER = 'v20261110h';
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
    // 通路别用纯黑：迷雾本身是不透明纯黑，通路若也是纯黑，视野内「挖空」的地面
    // 和视野外的迷雾就完全长得一样。也不能太暗 —— 浅黑过渡带是 #141719，
    // 通路亮度必须明显高过它，玩家才一眼分得出「看得见的地面」和「灯光边缘」。
    // R/G/B 要接近（色相弱）：绿墙像素判定用 G>60 && G>R*1.4，偏绿的路面会被误认成墙。
    // 备选：青灰 '#3d5050'、暖褐 '#4f463c'、旧深蓝青 '#13232b'。
    FLOOR: '#39424c',         // 通路底色（冷石板灰）
    EXIT: '#ff2d2d',          // 出口红格 / 边缘箭头
    DEFAULT_COLOR: '#ffffff', // 默认主角颜色

    // ---- 手感 ----
    STEP_MS: 90,              // 按住方向键时每格间隔（毫秒）
    STEP_MAX_CATCHUP: 3,      // 单帧最多补走几格（掉帧后别一口气穿墙）
    BUMP_MS: 120,             // 撞墙抖动时长
    PULSE_MS: 260,            // 呼吸/闪烁节奏（出口、箭头共用）

    // ---- 迷雾 ----
    // 视野 = 玩家上下左右四条直线（遇绿墙即停，墙本身可见）
    //       + 从直线上的通路格向四邻「探头」FOG_PEEK 格（路口一瞥 / 墙轮廓）。
    // 墙格不会被继续扩散，所以墙后面的通路永远照不亮。
    FOG_SIGHT: 6,             // 直线视距（格）；0 = 只看自己
    FOG_PEEK: 1,              // 一瞥深度（格）；0 = 严格纯十字
    // 雾层只有三档：亮（lit 挖空露底图）/ 浅黑（FOG_HALF 色块）/ 黑（纯黑）。
    // 浅黑 = 灯光渐隐带 + 走过的残影，全部填**不透明**的同一个中性色：
    // 不再叠半透明黑，所以不会透出底图的绿墙/蓝地面，也不会泄露浅黑后面是墙还是路。
    FOG_HALF: '#141719',      // 透明浅黑（中性深灰，几乎无色相）
    FOG_FADE_RINGS: 2,        // 视野外浅黑带宽度（格）；0 = 只剩亮/黑两档

    // ---- 岔路 ----
    // 生长树（Growing Tree）的「取最近格」概率：
    //   1.0 = 纯递归回溯，一条蜿蜒长廊，约 20 格才一个岔路口（简单）
    //   0.75 = 岔路明显变多，仍保留较长的走廊（推荐）
    //   0.5  = 接近 Prim，灌木型，岔路密集但每段都短（手忙脚乱）
    BRANCH_P: 0.72,

    // ---- 宝物（只放岔路尽头） ----
    // 死路尽头数量几乎按 N² 增长：30 格约 36 条，100 格约 379 条。
    // 阶梯 4/8/12 都是 4 的倍数 → 正面:负面恰好 3:1，且负面天然保底 1 个。
    TREASURE_TIERS: [[49, 4], [79, 8], [100, 12]],
    TREASURE_MIN_DIST: 8,     // 离起点的路径距离下限：别一开局就白捡
    TREASURE_MIN_GAP: 12,     // 两个宝物间的路径距离下限（贪心分散，放不满会逐档放宽）
    TREASURE_GLOW: '#ffd45a', // 宝物格边缘的黄光
    XRAY_RADIUS: 3,           // 「墙后视野」：主角周围无视墙体挖空的半径（格）
    TOAST_MS: 2000,           // 拾取宝物提示停留时长
    TIME_BONUS_MS: 15000,     // 非迷雾模式正面奖励：已用时间 −15 秒
    TP_GRACE_MS: 1200,        // 随机传送 / 身后刷怪后的短暂无敌，避免落地即挨打

    // ---- 终点指引 ----
    HINT_DEFAULT: true,       // 默认开启「出口在画面外时边缘箭头」
    HINT_PAD: 1.3,            // 箭头离画面四边的边距（格）；HUD 在画面外，四边对称不留额外空档

    // ---- 生成动画 ----
    GEN_FRAMES: 70,           // 目标帧数（不管地图多大都约 1.2 秒放完）
    GEN_FRAME_MS: 12,         // 单帧生成耗时上限，防卡顿
    GEN_DONE_MS: 420,         // 进度到 100% 后停顿多久再进迷宫

    // ---- 敌人 ----
    // 速度都以「主人公按住移动键时的速度」为 1（= 每 STEP_MS 走一格）
    // 数量不在这里配：= 本局放下的宝物数（4 / 8 / 12），见 TREASURE_TIERS。
    // 终点守卫占 1 个名额，于是「一个宝物一只」总是差一只 → 恰好留一个宝物没有守卫。
    ENEMY_ROAM: 0.5,          // 巡游：一半速度，且不追人
    ENEMY_RAGE: 2 / 3,        // QTE 失败后：三分之二速度，开始追人
    ENEMY_EXIT_R: 4,          // 终点守卫：在终点周围这个半径（格）内生成
    ENEMY_CHEST_R: 3,         // 宝物守卫：沿路径距宝物 1~ 这个格数（不穿墙、不压宝物）
    ENEMY_CHEST_MIN_START: 8, // 宝物守卫离起点的路径距离下限：别一开局就撞上
    ENEMY_MIN_DIST: 12,       // 终点守卫与起点的路径距离下限：别一开局就撞上
    ENEMY_HIT_R: 0.55,        // 与主人公重叠判定（格）

    // ---- QTE（对抗敌人） ----
    QTE_KEYS: 2,              // 需要按下的方向键数量（按顺序）
    QTE_WARN_MS: 1000,        // 判定前的「反击！」提醒时长（此期间敌我定住）
    QTE_MS: 1800,             // 判定时长：两个键 1.8 秒，手够快也够紧张
    QTE_LOCK_MS: 1500,        // 判定失败后，同一个敌人多久才能再被判定
    QTE_GAP_MS: 700,          // 两次判定之间的最小间隔，防连环弹窗
    QTE_RANGE: 6,             // 无迷雾时，进到这个格数内才算「对上眼」
    QTE_ADJ_REACH: 1,         // 迷雾下贴脸例外半径（格，切比雪夫）：斜对角也算；调大会让拐角又提前判定
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

  // ==================== 小工具 ====================
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  // 全项目统一的格坐标边界判定（MC 网格用的是另一套边界，不走这里）
  function inBounds(x, y) { return x >= 0 && x < N && y >= 0 && y < N; }
  function pulse(now) { return 0.5 + 0.5 * Math.sin(now / CFG.PULSE_MS); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function inGame() { return state === ST.PLAYING || state === ST.WIN || state === ST.LOSE; }
  // 原地洗牌：刷怪点、宝物候选、正负面标记共用这一份
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var r = (Math.random() * (i + 1)) | 0;
      var t = a[i]; a[i] = a[r]; a[r] = t;
    }
    return a;
  }

  // ==================== DOM ====================
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
  var wrap = $('wrap'), side = $('side');
  var stagewrap = $('stagewrap'), musicbar = $('musicbar'), toolbar = $('toolbar');
  var hud = $('hud'), hudTime = $('hudTime'), hudSteps = $('hudSteps');
  var ovStart = $('ovStart'), ovSetup = $('ovSetup'), ovGen = $('ovGen'), ovWin = $('ovWin');
  var ovRoute = $('ovRoute');
  var btnViewRoute = $('btnViewRoute'), btnViewRouteLose = $('btnViewRouteLose');
  var btnKb = $('btnKb'), kbLabel = $('kbLabel'), pad = $('pad');
  var btnRestart = $('btnRestart');
  var btnRescue = $('btnRescue');
  var btnStart = $('btnStart'), btnEnter = $('btnEnter'), btnBack = $('btnBack');
  var winTime = $('winTime'), winSteps = $('winSteps'), winChests = $('winChests');
  var loseChests = $('loseChests');
  var toastBox = $('toast'), toastName = $('toastName'), toastDesc = $('toastDesc');
  var barFill = $('barFill'), genPct = $('genPct'), genTip = $('genTip');
  var preview = $('preview'), cpick = $('cpick'), swatches = $('swatches');
  var sizeRange = $('sizeRange'), sizeVal = $('sizeVal'), sizeNote = $('sizeNote');
  var fogChk = $('fogChk'), muteBtn = $('muteBtn'), volRange = $('volRange');
  var hintChk = $('hintChk'), hintField = $('hintField'), hintNote = $('hintNote');
  var heartsBox = $('hearts');
  var qteBox = $('qte'), qteKeys = $('qteKeys'), qteBar = $('qteBar'), qteNum = $('qteNum');
  var warnBox = $('qteWarn'), warnBar = $('qteWarnBar');
  var ovLose = $('ovLose'), loseTime = $('loseTime'), loseSteps = $('loseSteps'), btnRetry = $('btnRetry');

  // 拾取宝物提示：只在舞台内浮 2 秒，不碰遮罩层，也不参与 showOnly
  // 所有遮罩集中一处：显示/收起、compact 档位都查这张表，新增遮罩只改这里
  var OVERLAYS = [ovStart, ovSetup, ovGen, ovWin, ovLose, ovRoute];

  // 离屏画布：整张迷宫底图 / 迷雾层（每帧只贴图，省性能）
  var bgc = document.createElement('canvas');
  var bx = bgc.getContext('2d');
  var fogc = document.createElement('canvas');
  var fx = fogc.getContext('2d');

  // ==================== 状态 ====================
  var state = ST.START;
  var curOverlay = null;          // 当前挂着的遮罩（draw 的自愈检查用它，免去每帧读 DOM）
  var grid = new Uint8Array(1);     // 1 = 墙（绿），0 = 通路（CFG.FLOOR 深冷青灰）
  var explored = new Uint8Array(1); // 曾经真正看见过的格（残影），只由 lit 累积
  var lit = new Uint8Array(1);      // 本帧看得见的格 —— 全项目唯一的视野真源
  var fade = new Uint8Array(1);     // 视野外浅黑带档位：0 = 纯黑，n = 第 n 圈
                                    // （档位只供回归诊断，绘制时统一用 FOG_HALF）
  var litList = [];                 // lit 的索引列表，供裁剪与自动化回归使用
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

  // ---- 宝物 / 能力 ----
  // treasures 是宝物系统的唯一真源：总数 = length，已收集数从 got 派生，
  // 不再另存两个计数器（否则每次重置/换尺寸都得四处同步，迟早不同步）。
  var treasures = [];       // { x, y, i, good, got }；good 是预分配的正负面标记（玩家看不见）
  var walked = new Uint8Array(1); // 真正踩过的格（布尔表），供「照亮走过的路线」用
  // 路线总结用：有序轨迹（含起点）与断点。跟 walked 分开存 —— walked 只回答
  // 「这格有没有踩过」，回放需要「第几步走到哪格」。名字避开 boons.trail。
  var walkTrail = [];       // 格索引序列，每走一步 push 一格
  var walkBreaks = [];      // walkTrail 中与上一格不相邻的索引（负面宝物随机传送）
  var lastCell = -1;        // 上一格（「在身后生成一个敌人」用）
  // beacon = 「双生信标」：终点红格 + 所有未收集宝物一起常亮（仅迷雾模式）
  var boons = { trail: false, xray: false, beacon: false, enemies: false };
  var timeBonusMs = 0;      // 已用时间的减免（非迷雾模式的正面奖励）
  var goodBag = [], badBag = []; // 能力抽取袋：抽空再洗，保证同类型里不连着重复
  var toastTimer = 0;

  // BFS 复用缓冲（追人找路 + 生成时算起点的路径距离）
  var bfsDist = new Int32Array(1);
  var bfsSeen = new Uint32Array(1);
  var bfsQueue = new Int32Array(1);
  var bfsGen = 0;

  // ==================== 尺寸 ====================
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
    lit = new Uint8Array(N * N);
    fade = new Uint8Array(N * N);
    walked = new Uint8Array(N * N);
    litList.length = 0;
    walkTrail.length = 0;
    walkBreaks.length = 0;
    // 换了尺寸，上一局所有跟坐标相关的状态就全失效了
    treasures.length = 0;
    lastCell = -1;

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
    bx.fillStyle = grid[i] === 1 ? CFG.WALL : CFG.FLOOR;
    bx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
  }

  function paintAll() {
    for (var i = 0; i < N * N; i++) paintCell(i);
  }

  // ==================== 迷雾 ====================
  // 视野只沿四条正交直线走：一路走到第一堵绿墙（墙本身要看得见，否则分不清
  // 「前面是墙」和「前面没探索过」），最多 FOG_SIGHT 格。
  // 再从直线上的通路格向四邻探头 FOG_PEEK 层：既给出走廊两侧的墙轮廓，
  // 也能在岔路口瞥见隔壁 1 格。关键约束是 **墙格不进扩散队列** ——
  // 一旦允许从墙继续往外走，就等于把墙后的通路也照亮了。
  // 视野之外是一圈统一的浅黑（见 computeFade），墙格只进浅黑、不把光带到墙那边，
  // 即「上帝视角不穿墙」。
  function computeSight() {
    // 尺寸缓冲万一没跟上（例如刚开始就被切了迷雾），就地补齐，避免越界静默失败
    if (lit.length !== N * N || fade.length !== N * N) {
      lit = new Uint8Array(N * N);
      fade = new Uint8Array(N * N);
    }
    lit.fill(0);
    fade.fill(0);
    litList.length = 0;
    if (!fogOn) return;

    var i, d, k, x, y, ni;
    var spine = [py * N + px];       // 直线上的通路格（含玩家），只有它们能向外探头
    lit[spine[0]] = 1;

    for (d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (k = 1; k <= CFG.FOG_SIGHT; k++) {
        x = px + dx * k; y = py + dy * k;
        if (!inBounds(x, y)) break;
        ni = y * N + x;
        lit[ni] = 1;                  // 视野尽头那面墙也算照亮
        if (grid[ni] === 1) break;    // 到此为止，绝不越过它
        spine.push(ni);
      }
    }

    var frontier = spine;
    for (k = 0; k < CFG.FOG_PEEK; k++) {
      var next = [];
      for (i = 0; i < frontier.length; i++) {
        var si = frontier[i], sx = si % N, sy = (si / N) | 0;
        for (d = 0; d < 4; d++) {
          var nx = sx + DIRS[d][0], ny = sy + DIRS[d][1];
          if (!inBounds(nx, ny)) continue;
          ni = ny * N + nx;
          if (lit[ni]) continue;
          lit[ni] = 1;
          if (grid[ni] === 0) next.push(ni);   // 只有通路格能继续带路
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    for (i = 0; i < N * N; i++) if (lit[i]) litList.push(i);

    computeFade();
  }

  // 视野外的浅黑带：从所有「看得见的通路格」按距离扩散 FOG_FADE_RINGS 圈。
  // 所有邻格都进浅黑带（含墙格），但只有通路格继续往外带路 ——
  // 墙那一侧因此永远拿不到档位，保持纯黑（不穿墙）。
  // 档位 1/2 只是距离记录，绘制时统一填 FOG_HALF，不再分浓度。
  // 已经 lit 的格子不参与，避免把视野内再刷一遍。
  function computeFade() {
    var steps = CFG.FOG_FADE_RINGS;
    if (!steps) return;
    var seeds = [], i, d, si, sx, sy, nx, ny, ni;
    for (i = 0; i < litList.length; i++) {
      si = litList[i];
      if (grid[si] !== 0) continue;
      seeds.push(si);
      fade[si] = 255;               // 哨兵：种子本身不算渐隐带
    }
    var frontier = seeds;
    for (d = 1; d <= steps; d++) {
      var next = [];
      for (i = 0; i < frontier.length; i++) {
        si = frontier[i]; sx = si % N; sy = (si / N) | 0;
        for (var k = 0; k < 4; k++) {
          nx = sx + DIRS[k][0]; ny = sy + DIRS[k][1];
          if (!inBounds(nx, ny)) continue;
          ni = ny * N + nx;
          if (lit[ni] || fade[ni]) continue;
          fade[ni] = d;                       // 墙格也进浅黑带，但不往外带光
          if (grid[ni] === 0) next.push(ni); // 只有通路格能继续扩散
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    for (i = 0; i < seeds.length; i++) fade[seeds[i]] = 0;
  }

  // 迷雾画布：三档配色 —— 亮（lit 挖空露底图）/ 浅黑（FOG_HALF 色块）/ 黑（纯黑）。
  // 浅黑是**不透明**的中性色块，不是半透明黑叠在底图上：
  // 既不会透出绿墙/蓝地面的色相，也不会泄露浅黑后面是墙还是路，画面只有三种颜色。
  // 渐隐带与走过的残影合并成同一档浅黑，久看不累。
  function rebuildFog() {
    computeSight();
    fx.clearRect(0, 0, SIZE, SIZE);
    if (!fogOn) return;

    var i, ci, cx, cy;
    for (i = 0; i < litList.length; i++) explored[litList[i]] = 1;

    // 先整片纯黑打底
    fx.fillStyle = '#000000';
    fx.fillRect(0, 0, SIZE, SIZE);

    // 再把「渐隐带 + 残影」统一填成浅黑（一次设色，不再分浓度、不分墙/路）
    fx.fillStyle = CFG.FOG_HALF;
    for (i = 0; i < N * N; i++) {
      if (lit[i]) continue;
      if (!explored[i] && !(fade[i] > 0 && fade[i] <= CFG.FOG_FADE_RINGS)) continue;
      cx = i % N; cy = (i / N) | 0;
      fx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }

    // 视野内最后挖空，保证它绝对清晰（不会被浅黑盖住）
    for (i = 0; i < litList.length; i++) {
      ci = litList[i];
      fx.clearRect((ci % N) * CELL, (((ci / N) | 0)) * CELL, CELL, CELL);
    }

    // ---- 视野类正面能力：只挖雾层，不改 lit ----
    // lit 仍是「能不能被直视」的唯一真源，QTE / 救命线判定绝不穿墙。
    // 「足迹长明」「隔墙之眼」在这里挖雾层；隔墙之眼另外放行实体显隐
    // （宝物 / 敌人 / 终点红格，见 xrayLit + entityVisible + clipToSight），
    // 但那只是「看得见」，不是「能判定」，也不是把格子塞进 lit。
    if (boons.trail) {
      for (i = 0; i < N * N; i++) {
        if (!walked[i] || lit[i]) continue;
        fx.clearRect((i % N) * CELL, (((i / N) | 0)) * CELL, CELL, CELL);
      }
    }
    if (boons.xray) {
      var R = CFG.XRAY_RADIUS;
      for (var dy = -R; dy <= R; dy++) {
        for (var dx = -R; dx <= R; dx++) {
          var x = px + dx, y = py + dy;
          if (!inBounds(x, y)) continue;
          if (lit[y * N + x]) continue;
          fx.clearRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
  }

  function resetFog() {
    explored.fill(0);
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
  // 描边保证它在绿墙和石板灰地面上都看得清。
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

    // HUD 已经移到画面下方，画布里四边留白对称即可，不必再为它让位
    var padSide = CELL * CFG.HINT_PAD;
    var padB = padSide;

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

  // 「隔墙之眼」挖开的是玩家周围 XRAY_RADIUS 格的正方形（见 rebuildFog），
  // 只动雾层、不往 lit 里塞格子。这里是同一片区域的「实体可见」判定：
  // 地形之外，宝物 / 敌人 / 终点红格也在这一片里现身。
  // QTE 判定不查它 —— 隔着墙不算「对上眼」，否则就成了透视外挂。
  function xrayLit(x, y) {
    if (!fogOn || !boons.xray || !inBounds(x, y)) return false;
    return Math.abs(x - px) <= CFG.XRAY_RADIUS && Math.abs(y - py) <= CFG.XRAY_RADIUS;
  }

  // 「双生信标」是不是开着：它让实体全图常亮，但同样不动 lit。
  function beaconOn() { return fogOn && boons.beacon; }

  // 终点红格与宝物共用同一个显隐判定：平时只认真视野；
  // 双生信标 → 全图常亮；隔墙之眼 → 只放行它挖开的那一片。
  // 两者都只放宽「画不画」，不改 lit，也不影响 QTE / 救命线判定。
  function entityVisible(x, y) {
    return beaconOn() || cellLit(x, y) || xrayLit(x, y);
  }

  // 宝物：底色跟主人公一模一样，靠「边缘泛黄光」区分。
  // 画在雾层之上、实体裁剪区之内 —— 迷雾下没被直视到的宝物不会漏出来，
  // 除非「双生信标」让它全图常亮，或「隔墙之眼」把它挖进了可见的那一片。
  function drawTreasures(now) {
    var k = pulse(now);
    var inset = Math.max(1, CELL * 0.1);
    var w = CELL - inset * 2;
    var lw = Math.max(1, CELL * 0.12);
    for (var i = 0; i < treasures.length; i++) {
      var t = treasures[i];
      if (t.got || !entityVisible(t.x, t.y)) continue;
      var x = (t.x - camX) * CELL, y = (t.y - camY) * CELL;
      // 两次 save 是刻意的：黄光只给方块本体当光晕，描边必须在没有阴影的
      // 干净画布状态里画，否则黄边会被 shadowBlur 糊成一团。
      ctx.save();
      ctx.shadowColor = CFG.TREASURE_GLOW;
      ctx.shadowBlur = CELL * (0.45 + 0.45 * k);
      ctx.fillStyle = playerColor;
      ctx.fillRect(x + inset, y + inset, w, w);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.72 + 0.28 * k;
      ctx.strokeStyle = CFG.TREASURE_GLOW;
      ctx.lineWidth = lw;
      ctx.strokeRect(x + inset + lw / 2, y + inset + lw / 2, w - lw, w - lw);
      ctx.restore();
    }
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

    hudTime.textContent = fmt(elapsed(now));
  }

  // 迷雾层：进迷宫就整片覆盖，不做「先亮一下再淡入」。
  // 雾层自己已经把 lit 格挖空，这里只负责贴上去。
  // 原来的「硬保险」是整块 5×5 贴回底图 —— 它恰恰是穿墙的元凶，已删除；
  // 换成自愈：万一视野没算过（例如刚换过地图尺寸），补算一次，避免整屏黑。
  function drawFog(vw) {
    if (litList.length === 0) rebuildFog();
    ctx.drawImage(fogc, camX * CELL, camY * CELL, vw, vw, 0, 0, vw, vw);
  }

  // 出口红格平时只有「真的被照亮」时才画：迷雾里不许透出来指路。
  // 「双生信标」全图常亮；「隔墙之眼」只放行它挖开的那一片（与宝物共用判定）。
  function exitVisible() {
    if (exitI < 0) return false;
    return entityVisible(exitI % N, (exitI / N) | 0);
  }

  // 实体（出口红格、宝物、敌人、碎片、主角）都画在雾层之上，shadowBlur 的光晕
  // 本来会溢出到墙外。统一裁到 lit 的格子里，连光晕都不许穿墙。
  // 边缘箭头与受伤暗角属于 HUD，故意留在裁剪之外。
  function clipToSight() {
    ctx.beginPath();
    for (var i = 0; i < litList.length; i++) {
      var ci = litList[i];
      ctx.rect((ci % N - camX) * CELL, (((ci / N) | 0) - camY) * CELL, CELL, CELL);
    }
    // 「双生信标」/「敌影显现」/「隔墙之眼」把本来在雾里的实体也拉进裁剪区，
    // 否则它们虽然通过了显隐判定，却会被 clip 切得干干净净。
    // 信标要补两类格子：终点红格 + 每一个还没被捡走的宝物。
    if (beaconOn()) {
      if (exitI >= 0) addClipCell(exitI % N, (exitI / N) | 0);
      for (i = 0; i < treasures.length; i++) {
        if (!treasures[i].got) addClipCell(treasures[i].x, treasures[i].y);
      }
    }
    // 隔墙之眼按「实体所在格」补，不整片放行 —— 整片加进来的话，
    // 救命白线也会跟着穿墙露出，那不是这个能力要给的信息。
    if (fogOn && boons.xray) {
      var ex = exitI % N, ey = (exitI / N) | 0;
      if (exitI >= 0 && xrayLit(ex, ey)) addClipCell(ex, ey);
      for (i = 0; i < treasures.length; i++) {
        if (!treasures[i].got && xrayLit(treasures[i].x, treasures[i].y))
          addClipCell(treasures[i].x, treasures[i].y);
      }
      for (i = 0; i < enemies.length; i++) {
        var xc = enemyCells(enemies[i]);
        for (var j = 0; j < xc.length; j++) {
          if (xrayLit(xc[j][0], xc[j][1])) addClipCell(xc[j][0], xc[j][1]);
        }
      }
    }
    if (fogOn && boons.enemies) {
      for (i = 0; i < enemies.length; i++) {
        var cs = enemyCells(enemies[i]);
        for (var k = 0; k < cs.length; k++) addClipCell(cs[k][0], cs[k][1]);
      }
    }
    ctx.clip();
  }

  // clampCam 保证摄像机窗口恒在 [0,N) 内，所以过了窗口检查就必然 inBounds，
  // 不必再判一次全图边界；窗口外的格子本来也不会画出来。
  function addClipCell(x, y) {
    if (x < camX || x >= camX + VIEW || y < camY || y >= camY + VIEW) return;
    ctx.rect((x - camX) * CELL, (y - camY) * CELL, CELL, CELL);
  }

  // 只画不改状态：所有绘制都在这里，顺序 = 图层顺序
  function draw(now) {
    // 路线页是盖住整个画面的不透明遮罩，这时底下那张迷宫图不用再逐帧重画
    if (curOverlay === ovRoute) return;
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
      if (hintOn) drawExitHint(now);   // 边缘箭头是 HUD，不受视野裁剪

      var clipped = fogOn && litList.length > 0;
      if (clipped) { ctx.save(); clipToSight(); }
      drawRescue(now);                 // 救命白线：当地面标线，压在出口下面
      if (exitVisible()) drawExit(now);// 红格本体：迷雾开着时要走到眼前才看得见
      drawEnemies(now);                // 敌人：被迷雾挡住的不画
      drawEffects(now);                // 裂开的碎片
      drawTreasures(now);              // 宝物：平时只在视野里现身，信标全图常亮 / 隔墙之眼放行它挖开的那一片
      drawPlayer(now);
      if (clipped) ctx.restore();

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

  // 调试接口：只读状态 + 几个测试用动作（tp 传送、hurt 扣血、take/apply 等）。
  // tp 会像宝物传送一样在 walkTrail 里留一个断点，回放数据才不会自相矛盾。
  // 正常玩法完全不依赖这里，删掉整块游戏也照跑。
  window.MazeDebug = {
    get ver() { return VER; },
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
    enemyCount: function () { return enemyCount(); },
    los: function (ax, ay, bx, by) { return hasLineOfSight(ax, ay, bx, by); },
    lit: function (x, y) { return inBounds(x, y) && lit[y * N + x] === 1; },
    litCells: function () { return litList.slice(); },
    fade: function (x, y) { return inBounds(x, y) ? fade[y * N + x] : 0; },
    fogCfg: function () { return { half: CFG.FOG_HALF, rings: CFG.FOG_FADE_RINGS, sight: CFG.FOG_SIGHT, peek: CFG.FOG_PEEK, floor: CFG.FLOOR, wall: CFG.WALL }; },
    cellVisible: function (x, y) { return cellLit(x, y); },
    xray: function (x, y) { return xrayLit(x, y); },
    entityVisible: function (x, y) { return entityVisible(x, y); },
    qteRange: function (x, y) { return cellInQteRange(x, y); },
    qteCfg: function () { return { range: CFG.QTE_RANGE, adj: CFG.QTE_ADJ_REACH }; },
    qteEnemy: function (e) { return enemyInQteRange(e); },
    explored: function (x, y) { return inBounds(x, y) && explored[y * N + x] === 1; },
    cell: function (x, y) { return !inBounds(x, y) ? 1 : grid[y * N + x]; },
    // ---- 宝物 / 能力（回归测试用） ----
    get treasures() {
      return treasures.map(function (t) {
        return { x: t.x, y: t.y, i: t.i, good: t.good, got: t.got };
      });
    },
    get collected() { return chestGot(); },
    get treasureTotal() { return treasures.length; },
    get boons() { return { trail: boons.trail, xray: boons.xray, beacon: boons.beacon, enemies: boons.enemies }; },
    get timeBonus() { return timeBonusMs; },
    walked: function (x, y) { return inBounds(x, y) && walked[y * N + x] === 1; },
    // ---- 路线总结（回归测试用只读快照） ----
    route: function () { return window.MazeRoute ? window.MazeRoute.snapshot() : null; },
    get trail() { return walkTrail.slice(); },
    get trailBreaks() { return walkBreaks.slice(); },
    get solution() { return traceBfsPath(1 * N + 1, exitI); },
    chestCount: function (n) { return chestCount(n || N); },
    step: function (dx, dy) { tryMove(dx, dy); },
    take: function (k) { if (treasures[k]) collectTreasure(treasures[k], performance.now()); },
    apply: function (key) { applyAbility(key, performance.now()); },
    fogOn: function () { return fogOn; },
    dist: function (ax, ay, bx, by) {
      bfsFrom(ax, ay);
      var i = by * N + bx;
      return (i >= 0 && i < N * N && bfsSeen[i] === bfsGen) ? bfsDist[i] : -1;
    },
    tp: function (x, y) {
      px = x; py = y; clampCam(); rebuildFog();
      // 调试用的瞬移跟宝物传送一样是「跳跃」，轨迹里也得留个断点
      var i = y * N + x;
      if (walkTrail.length) { walkTrail.push(i); walkBreaks.push(walkTrail.length - 1); }
    },
    hurt: function () { damagePlayer(performance.now()); }
  };

  // ==================== 敌人 ====================
  // 样子：红边白格 + 中心黑格（面积占整格 1/3，像一只眼球）。
  // 行为：平时按「主人公按住移动键时速度的一半」在通路里游荡、不追人；
  //       QTE 失败后进入「狂暴」，速度升到 2/3 并开始 BFS 追人（不会穿墙）。
  function playerSpeed() { return 1 / CFG.STEP_MS; }   // 格 / 毫秒

  // 敌人总数 = 本局实际放下的宝物数量（30~49→4、50~79→8、80~100→12）。
  // 终点守卫固定占 1 个名额，剩下的「一个宝物一只」正好差一只，
  // 所以每局都恰好有一个宝物附近没有敌人。
  // 保底 1 只：万一这张图连一个宝物都放不下，终点守卫也照样刷。
  // 注意依赖顺序：placeTreasures() 必须先于 spawnEnemies()（见 enterMaze）。
  function enemyCount() {
    return Math.max(1, treasures.length);
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
        if (!inBounds(nx, ny)) continue;
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
      if (!inBounds(nx, ny)) continue;
      var ni = ny * N + nx;
      if (grid[ni] === 1 || bfsSeen[ni] !== bfsGen) continue;
      if (bfsDist[ni] < bestD) { bestD = bfsDist[ni]; best = [nx, ny]; }
    }
    return best;
  }

  // 挑「终点附近、但离起点足够远」的通路格当刷怪点。
  // 两道距离门槛都是为了「别一开局就遇上」：路径距离够长 + 不在起点眼皮底下。
  // 分三档逐级放宽（最终只要还在终点半径内就收），保证「终点必刷一只」不会
  // 因为门槛太严而退化成全图随机；终点/起点/墙格一律不当落脚点。
  function collectSpawnCells() {
    bfsFrom(1, 1);                     // 起点 (1,1)
    var g = bfsGen;

    var maxD = 0;
    for (var i = 0; i < N * N; i++) {
      if (bfsSeen[i] === g && bfsDist[i] > maxD) maxD = bfsDist[i];
    }
    var minD = Math.max(CFG.ENEMY_MIN_DIST, Math.round(maxD * 0.4));
    if (minD > maxD) minD = Math.round(maxD * 0.6);

    var ex = exitI % N, ey = (exitI / N) | 0;
    var startI = 1 * N + 1, R = CFG.ENEMY_EXIT_R;
    var strict = [], loose = [], near = [];
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        var x = ex + dx, y = ey + dy;
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) continue;
        var idx = y * N + x;
        if (grid[idx] !== 0 || idx === startI || idx === exitI) continue;
        if (bfsSeen[idx] !== g) continue;
        var cell = [x, y];
        near.push(cell);
        if (Math.abs(x - 1) + Math.abs(y - 1) < 8) continue;
        if (bfsDist[idx] >= minD) strict.push(cell);
        else loose.push(cell);
      }
    }

    // 终点周围被墙挤得太干净时退一步：全图挑「离起点足够远」的通路格
    var cand = strict.length ? strict : (loose.length ? loose : near);
    if (!cand.length) {
      var far = Math.max(6, Math.round(maxD * 0.5));
      for (var j = 0; j < N * N; j++) {
        if (grid[j] !== 0) continue;
        if (bfsSeen[j] !== g || bfsDist[j] < far) continue;
        cand.push([j % N, (j / N) | 0]);
      }
    }
    if (!cand.length) cand.push([ex, ey]);
    return shuffle(cand);
  }

  // 宝物守卫的落脚点：沿「路径距离」在宝物 1~ENEMY_CHEST_R 格内挑，
  // 所以绝不会隔着一堵墙站在旁边。不压任何宝物/终点/起点、不与已派出的敌人重叠；
  // 优先挑离起点够远的格，实在没有才放宽（宝物本身已在 8 步之外）。
  function chestSpawnCell(chestI, used, blocked, startDist) {
    bfsFrom(chestI % N, (chestI / N) | 0);
    var g = bfsGen, R = CFG.ENEMY_CHEST_R;
    var safe = [], any = [];
    for (var i = 0; i < N * N; i++) {
      if (grid[i] !== 0 || blocked[i] || used[i]) continue;
      if (bfsSeen[i] !== g || bfsDist[i] < 1 || bfsDist[i] > R) continue;
      if (startDist[i] < 0) continue;
      var cell = [i % N, (i / N) | 0];
      if (startDist[i] >= CFG.ENEMY_CHEST_MIN_START) safe.push(cell);
      else any.push(cell);
    }
    var pool = safe.length ? safe : any;
    return pool.length ? pool[(Math.random() * pool.length) | 0] : null;
  }

  // 刷怪分配：总数恒等于本局宝物数量。
  // ① 终点附近必刷 1 只（固定 enemies[0]）→ ② 剩下的按「一个宝物 1 只」派到
  //    宝物附近，派满即止 → ③ 周围没落脚点时，剩余名额退回终点附近。
  //    因为②只派 cnt-1 只，最后恰好留一个宝物没有守卫。
  function spawnEnemies() {
    enemies.length = 0;
    effects.length = 0;
    if (exitI < 0) return;

    var cnt = enemyCount();
    var used = new Uint8Array(N * N);      // 已经站了敌人的格
    var blocked = new Uint8Array(N * N);   // 不许站人的格：宝物 / 终点 / 起点
    var startI = 1 * N + 1;
    blocked[startI] = 1;
    blocked[exitI] = 1;
    for (var b = 0; b < treasures.length; b++) blocked[treasures[b].i] = 1;

    var startDist = distMapFrom(startI);
    var allExit = collectSpawnCells();
    var exitCand = allExit.filter(function (c) { return !blocked[c[1] * N + c[0]]; });
    if (!exitCand.length) exitCand = allExit;   // 极端地形：宁可压宝物也别空着

    var cells = [];
    function take(cell) {
      cells.push(cell);
      used[cell[1] * N + cell[0]] = 1;
    }

    take(exitCand[0]);                      // ① 终点守卫

    // ② 宝物顺序打乱，每只敌人各占一个宝物，名额用完立刻停
    var chestOrder = shuffle(treasures.map(function (t) { return t.i; }));
    for (var t = 0; t < chestOrder.length && cells.length < cnt; t++) {
      var cell = chestSpawnCell(chestOrder[t], used, blocked, startDist);
      if (cell) take(cell);
    }

    // ③ 兜底：先挑终点附近没被占用的格，还不够才允许重叠
    for (var f = 0; cells.length < cnt && f < exitCand.length; f++) {
      var fc = exitCand[f];
      if (!used[fc[1] * N + fc[0]]) take(fc);
    }
    for (var z = 0; cells.length < cnt; z++) take(exitCand[z % exitCand.length]);

    for (var c = 0; c < cnt; c++) {
      var at = cells[c];
      enemies.push({
        x: at[0], y: at[1], tx: at[0], ty: at[1],
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
      if (!inBounds(nx, ny)) continue;
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

  // 单格是否在「视野」里：迷雾下统一查 lit（唯一真源），无迷雾下是摄像机窗口。
  // 敌人显隐、出口红格、QTE 判定、救命线裁剪全走这里，不允许各自再算距离。
  function cellLit(ex, ey) {
    if (ex < camX || ex >= camX + VIEW || ey < camY || ey >= camY + VIEW) return false;
    if (!fogOn) return true;
    if (!inBounds(ex, ey)) return false;
    return lit[ey * N + ex] === 1;
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
    // 「敌影显现」：迷雾里所有敌人都画出来（黑底上像一双双发光的眼睛）
    if (fogOn && boons.enemies) return true;
    var x = clamp(Math.round(e.x), 0, N - 1), y = clamp(Math.round(e.y), 0, N - 1);
    // 「隔墙之眼」挖开的那一片里，墙后的敌人也现身；QTE 判定仍只认真视野
    return cellLit(x, y) || xrayLit(x, y);
  }

  // 无迷雾时用的直线判定：同一行/列且中间没有墙。
  // 迷雾下不靠它 —— 视野集合本身已经把墙挡住了。
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

  // 迷雾下「对上眼」= 看得见，而且真的在同一条直走廊上。
  // lit 里除了四条直线，还有从直线格向四邻探头照亮的侧格（FOG_PEEK=1）；
  // 只查 lit 的话，拐角侧格里的敌人还没拐进直走廊就会弹 QTE，
  // 看上去像「敌人还在视野外就开始判定」。这里补回共线要求（复用无迷雾的
  // hasLineOfSight），侧格一律不判，敌人必须走进直线那一格才触发。
  // 唯一例外是贴脸 1 格：路口旁斜对角的敌人明明看得见，若也排除，
  // 就会退回「贴脸挨撞却不弹 QTE」的老毛病。
  // 视野集合 lit 本身不动：敌人显隐 / 出口 / 救命线照旧查它。
  // 无迷雾时整屏可见但一屏几十格，只认 QTE_RANGE 格内的「对上眼」。
  function cellInQteRange(ex, ey) {
    if (!cellLit(ex, ey)) return false;
    if (!fogOn) {
      var d = Math.max(Math.abs(ex - px), Math.abs(ey - py));
      return d <= CFG.QTE_RANGE && hasLineOfSight(ex, ey, px, py);
    }
    // 贴脸例外用切比雪夫距离，斜对角也算（路口一瞥）
    if (Math.max(Math.abs(ex - px), Math.abs(ey - py)) <= CFG.QTE_ADJ_REACH) return true;
    return hasLineOfSight(ex, ey, px, py);
  }

  // 敌人跨在两格之间时，它压着的任意一格「同走廊」就算对上眼。
  // 只按 round() 取一格的话，它跨过格线的那一帧会突然变成「斜对角」，
  // 贴脸却不出判定——手感上非常像 bug。
  // 但绘制只按主格（round）判断显隐：判定若只看压着的另一格，会出现
  // 「敌人还在黑雾里没画出来，QTE 却已经弹了」。所以先对齐显隐再谈范围。
  // 隔墙之眼 / 信标 / 敌影也会让主格「画面上可见」，但下面的 cellInQteRange
  // 仍要求真视野 lit + 同一条直走廊，隔墙看见的敌人不会被判定。
  function enemyInQteRange(e) {
    if (!enemyLit(e)) return false;
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
    } else if (fogOn && boons.enemies) {
      // 「敌影显现」：没被直视的敌人也带一圈黄光，免得它像贴在纯黑上的白纸片
      ctx.shadowColor = 'rgba(255,212,90,.9)';
      ctx.shadowBlur = CELL * 0.55;
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

    var spend = elapsed(performance.now());
    loseTime.textContent = fmt(spend);
    loseSteps.textContent = steps;
    loseChests.textContent = chestStats();
    hud.classList.remove('show');
    showOnly(ovLose);

    [330, 262, 196].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.22, 'triangle', 0.055); }, i * 150);
    });
  }

  // ==================== 救命指引 ====================
  // 从主人公所在格 BFS 到终点，回溯出一条格子序列，然后画成白线。
  // 迷雾模式下只在真实视野内可见（用 lit 格拼成裁剪区），不给穿墙透视。
  function traceBfsPath(fromI, toI) {
    // 全项目唯一的 BFS 回溯：完美迷宫里任意两格之间恰好一条路。
    // 救命线和路线总结的「正确路线」共用这一份，别再写第二份寻路。
    if (fromI < 0 || toI < 0 || fromI >= N * N || toI >= N * N) return null;
    if (fromI === toI) return [fromI];
    bfsFrom(fromI % N, (fromI / N) | 0);
    if (bfsSeen[toI] !== bfsGen) return null;

    var path = [], cur = toI, guard = 0;   // guard：兜底，正常一定会先回到起点
    while (cur !== fromI && guard++ < N * N) {
      path.push(cur);
      var cx = cur % N, cy = (cur / N) | 0, d = bfsDist[cur];
      var nxt = -1;
      for (var k = 0; k < 4; k++) {
        var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (!inBounds(nx, ny)) continue;
        var ni = ny * N + nx;
        if (grid[ni] === 1 || bfsSeen[ni] !== bfsGen) continue;
        if (bfsDist[ni] === d - 1) { nxt = ni; break; }
      }
      if (nxt < 0) return null;
      cur = nxt;
    }
    path.push(fromI);
    path.reverse();          // 改成「从起点到终点」
    return path;
  }

  function buildRescuePath() {
    if (state !== ST.PLAYING || exitI < 0) { rescuePath = null; return; }
    var s0 = py * N + px;
    if (s0 === exitI) { rescuePath = null; return; }
    rescuePath = traceBfsPath(s0, exitI);
  }

  function drawRescue(now) {
    if (!rescueOn || !rescuePath || rescuePath.length < 2) return;
    var i, ci, x0, y0;

    ctx.save();

    // 迷雾下的视野裁剪由 draw() 的 clipToSight() 统一处理，
    // 连白线的柔光也不会越到墙外。

    ctx.beginPath();
    for (i = 0; i < rescuePath.length; i++) {
      ci = rescuePath[i];
      x0 = (ci % N - camX) * CELL + CELL / 2;
      y0 = (((ci / N) | 0) - camY) * CELL + CELL / 2;
      if (i === 0) ctx.moveTo(x0, y0); else ctx.lineTo(x0, y0);
    }

    // 底下一层柔光，保证在绿墙和石板灰通路上都看得清
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
    // 离开路线页（返回结算 / 重开 / 再来一局）就停掉回放定时器，别让它在后台空转
    if (el !== ovRoute && window.MazeRoute) window.MazeRoute.close();
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
    // HUD 是悬在画面下方的绝对定位浮层，不占 flex 流的高度：
    // 显示与否都不影响可用高度，进迷宫前后画面尺寸完全一致。
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

    // 舞台尺寸变了，路线页那张独立 canvas 也要按新宽度重画（仅打开时）
    if (curOverlay === ovRoute && window.MazeRoute) window.MazeRoute.resize();

    // 悬空 HUD 贴着画面底边：高度太紧的横屏里画面下方已经没有落脚点，
    // 这时才贴回画面内底边（.inside），保证三项始终完整可见。
    // 只切 class、不改 s，画面尺寸依旧不受 HUD 影响。
    var hudH = hud.classList.contains('show') ? hud.offsetHeight : 0;
    var roomBelow = window.innerHeight - stagewrap.getBoundingClientRect().bottom;
    hud.classList.toggle('inside', hudH > 0 && roomBelow < hudH + 2);
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
    resetTreasures();          // 新一局的宝物 / 能力 / 时间奖励全部清零
    grid.fill(1);
    paintAll();
    // 新一局的迷雾在 enterMaze 里统一重建，这里只把旧数据清掉
    explored.fill(0);
    lit.fill(0);
    fade.fill(0);
    litList.length = 0;
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

  // ==================== 宝物 / 随机能力 ====================
  // 30~49 → 4 个，50~79 → 8 个，80~100 → 12 个。
  // 每档都是 4 的倍数，正好切成 3:1，负面宝物天然保底 1 个。
  function chestCount(n) {
    var tiers = CFG.TREASURE_TIERS;
    for (var i = 0; i < tiers.length; i++) if (n <= tiers[i][0]) return tiers[i][1];
    return tiers[tiers.length - 1][1];
  }

  // 结算页用的计数：全部从 treasures 派生，不另存状态
  function chestGot() {
    var n = 0;
    for (var i = 0; i < treasures.length; i++) if (treasures[i].got) n++;
    return n;
  }
  function chestStats() { return chestGot() + ' / ' + treasures.length; }

  // 宝物候选 = 岔路尽头（开口邻居恰好 1 个），排除起点 / 出口 / 起点附近 8 步内。
  function collectDeadEnds() {
    bfsFrom(1, 1);
    var g = bfsGen, out = [], i, k, d, x, y, nx, ny;
    var startI = 1 * N + 1;
    for (i = 0; i < N * N; i++) {
      if (grid[i] !== 0 || i === startI || i === exitI) continue;
      if (bfsSeen[i] !== g || bfsDist[i] < CFG.TREASURE_MIN_DIST) continue;
      x = i % N; y = (i / N) | 0; d = 0;
      for (k = 0; k < 4; k++) {
        nx = x + DIRS[k][0]; ny = y + DIRS[k][1];
        if (!inBounds(nx, ny)) continue;
        if (grid[ny * N + nx] === 0) d++;
      }
      if (d === 1) out.push(i);
    }
    return out;
  }

  // 从某格出发的整张距离表（Int32Array），给「贪心分散」用。
  // 完美迷宫里任意两格都连通，取不到距离的写 -1 只是兜底。
  function distMapFrom(i) {
    bfsFrom(i % N, (i / N) | 0);
    var g = bfsGen, m = new Int32Array(N * N), k;
    for (k = 0; k < N * N; k++) m[k] = (bfsSeen[k] === g) ? bfsDist[k] : -1;
    return m;
  }

  // 放宝物：先按 TREASURE_MIN_GAP 格的路径距离贪心挑，挑不满就逐档放宽到 0。
  // 死路尽头数量随 N² 增长，不分散的话 12 个宝物很容易全挤在同一片区域。
  function placeTreasures() {
    resetTreasures();
    if (exitI < 0) return;
    var want = chestCount(N);
    var cand = shuffle(collectDeadEnds());
    if (!cand.length) return;

    var chosen = [], maps = [], c, m, ci, ok;
    var gap = CFG.TREASURE_MIN_GAP;
    while (gap > 0 && chosen.length < want) {
      for (c = 0; c < cand.length && chosen.length < want; c++) {
        ci = cand[c];
        if (chosen.indexOf(ci) >= 0) continue;
        ok = true;
        for (m = 0; m < maps.length; m++) {
          if (maps[m][ci] >= 0 && maps[m][ci] < gap) { ok = false; break; }
        }
        if (!ok) continue;
        chosen.push(ci);
        maps.push(distMapFrom(ci));
      }
      if (chosen.length < want) gap = Math.floor(gap / 2);
    }
    for (c = 0; c < cand.length && chosen.length < want; c++) {
      if (chosen.indexOf(cand[c]) < 0) chosen.push(cand[c]);
    }
    if (!chosen.length) return;

    // 正负面标记（隐藏）先按 3:1 配好再打乱：保证「正面 ≈ 负面 3 倍」是每局都成立的，
    // 而不是靠概率碰运气；具体给哪个能力则留到拾取宝物那一刻才随机抽。
    var neg = Math.max(1, Math.round(chosen.length / 4));
    var tags = [];
    for (var i = 0; i < chosen.length; i++) tags.push(i >= neg);
    shuffle(tags);
    for (i = 0; i < chosen.length; i++) {
      ci = chosen[i];
      treasures.push({ i: ci, x: ci % N, y: (ci / N) | 0, good: tags[i], got: false });
    }
  }

  function resetTreasures() {
    treasures.length = 0;
    walked.fill(0);           // applyMapSize 已保证长度 = N*N
    lastCell = -1;
    boons.trail = boons.xray = boons.beacon = boons.enemies = false;
    timeBonusMs = 0;
    goodBag.length = 0;
    badBag.length = 0;
    hideToast();
  }

  // 正面能力全是「看」类增益，只在迷雾模式进池；非迷雾模式换成时间奖励。
  // 负面能力三种模式通用。
  var GOOD_FOG = [
    { key: 'trail',   name: '足迹长明', desc: '走过的路线永久照亮' },
    { key: 'xray',    name: '隔墙之眼', desc: '能看见墙后的地形与实体' },
    { key: 'beacon',  name: '双生信标', desc: '终点红格与所有宝物永远可见' },
    { key: 'enemies', name: '敌影显现', desc: '所有敌人永远可见' }
  ];
  var GOOD_PLAIN = [
    { key: 'time',    name: '时光倒流', desc: '已用时间 −15 秒' }
  ];
  var BAD = [
    { key: 'teleport', name: '空间错位', desc: '被随机传送到迷宫某处' },
    { key: 'bleed',    name: '双重创伤', desc: '损失两颗心' },
    { key: 'spawn',    name: '背后阴影', desc: '身后出现一个敌人' }
  ];

  function drawAbility(list, bag) {
    if (!bag.length) {
      for (var i = 0; i < list.length; i++) bag.push(list[i]);
      shuffle(bag);
    }
    return bag.pop();
  }

  function showToast(a, good) {
    clearTimeout(toastTimer);
    toastName.textContent = (good ? '奖励 · ' : '陷阱 · ') + a.name;
    toastDesc.textContent = a.desc;
    toastBox.classList.toggle('bad', !good);
    // 显隐只走和遮罩/QTE 一样的「show 类 + aria-hidden」两条通道，
    // 不再额外维护 hidden 属性，免得三个状态源彼此打架
    toastBox.classList.add('show');
    toastBox.setAttribute('aria-hidden', 'false');
    toastTimer = setTimeout(hideToast, CFG.TOAST_MS);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = 0;
    toastBox.classList.remove('show', 'bad');
    toastBox.setAttribute('aria-hidden', 'true');
  }

  function collectTreasureAt(i) {
    for (var k = 0; k < treasures.length; k++) {
      if (!treasures[k].got && treasures[k].i === i) {
        collectTreasure(treasures[k], performance.now());
        return;
      }
    }
  }

  function collectTreasure(t, now) {
    if (t.got) return;
    t.got = true;
    var a = drawAbility(
      t.good ? (fogOn ? GOOD_FOG : GOOD_PLAIN) : BAD,
      t.good ? goodBag : badBag
    );
    applyAbility(a.key, now);
    showToast(a, t.good);
    if (t.good) {
      beep(784, 0.07, 'triangle', 0.05);
      setTimeout(function () { beep(1046, 0.09, 'triangle', 0.045); }, 85);
    } else {
      beep(160, 0.2, 'sawtooth', 0.06);
    }
  }

  // 只接能力 key：name / desc 是给提示条用的，跟「能力效果」无关
  function applyAbility(key, now) {
    switch (key) {
      case 'trail':    boons.trail = true; rebuildFog(); break;
      case 'xray':     boons.xray = true; rebuildFog(); break;
      case 'beacon':   boons.beacon = true; break;
      case 'enemies':  boons.enemies = true; break;
      case 'time':     timeBonusMs += CFG.TIME_BONUS_MS; break;
      case 'teleport': randomTeleport(now); break;
      case 'bleed':    loseHearts(2, now); break;
      case 'spawn':    spawnBehind(now); break;
    }
  }

  // 随机传送：全图任一通路格，但避开出口、其它宝物、敌人身周 1 格和脚下这格，
  // 免得「踩雷」变成「直接通关」或「落地就被撞掉一颗心」。
  function randomTeleport(now) {
    // 一张排除表收齐所有「不能落」的格子：敌人身周、未开的宝物、出口、脚下
    var exclude = new Uint8Array(N * N), i, dx, dy, nx, ny;
    for (i = 0; i < enemies.length; i++) {
      var ex = clamp(Math.round(enemies[i].x), 0, N - 1);
      var ey = clamp(Math.round(enemies[i].y), 0, N - 1);
      for (dy = -1; dy <= 1; dy++) {
        for (dx = -1; dx <= 1; dx++) {
          nx = ex + dx; ny = ey + dy;
          if (inBounds(nx, ny)) exclude[ny * N + nx] = 1;
        }
      }
    }
    for (i = 0; i < treasures.length; i++) {
      if (!treasures[i].got) exclude[treasures[i].i] = 1;
    }
    if (exitI >= 0) exclude[exitI] = 1;
    exclude[py * N + px] = 1;

    var cand = [];
    for (i = 0; i < N * N; i++) {
      if (grid[i] !== 0 || exclude[i]) continue;
      cand.push(i);
    }
    if (!cand.length) return;

    var dest = cand[(Math.random() * cand.length) | 0];
    px = dest % N; py = (dest / N) | 0;
    walked[dest] = 1;
    // 传送是「跳」过去的：轨迹里记一格，并标记这一格与上一格不相邻
    walkTrail.push(dest);
    walkBreaks.push(walkTrail.length - 1);
    lastCell = -1;                 // 上一格已经没意义了，别让「背后刷怪」放到老位置
    invulnUntil = Math.max(invulnUntil, now + CFG.TP_GRACE_MS);
    clampCam();
    rebuildFog();
    beep(220, 0.18, 'sawtooth', 0.06);
    setTimeout(function () { beep(330, 0.12, 'square', 0.04); }, 90);
  }

  // 一次掉两颗心：复用同一套无敌帧 / 回血计时，血量下限 0，掉光直接判负。
  function loseHearts(n, now) {
    hp = Math.max(0, hp - n);
    invulnUntil = Math.max(invulnUntil, now + CFG.INVULN_MS);
    regenAt = (hp > 0 && hp < CFG.HP_MAX) ? now + CFG.REGEN_MS : 0;
    syncHearts();
    beep(110, 0.22, 'sawtooth', 0.07);
    if (hp <= 0) loseGame();
  }

  // 在「刚离开的那一格」刷一只敌人；开局没上一格就退而求其次找相邻通路。
  function spawnBehind(now) {
    var bx = -1, by = -1, k, nx, ny;
    if (lastCell >= 0 && lastCell < N * N && grid[lastCell] === 0) {
      bx = lastCell % N; by = (lastCell / N) | 0;
    } else {
      for (k = 0; k < 4; k++) {
        nx = px + DIRS[k][0]; ny = py + DIRS[k][1];
        if (!inBounds(nx, ny) || grid[ny * N + nx] !== 0) continue;
        bx = nx; by = ny; break;
      }
    }
    if (bx < 0) return;
    enemies.push({
      x: bx, y: by, tx: bx, ty: by, dir: null, rage: false,
      qteLockUntil: now + CFG.TP_GRACE_MS
    });
    // 给一点反应时间：它一出生就贴着后背，不保护的话几乎必挨一下
    invulnUntil = Math.max(invulnUntil, now + CFG.TP_GRACE_MS);
    beep(140, 0.2, 'sawtooth', 0.06);
  }

  // 用时 = 真实经过时间 − 时间奖励；fmt() 自己会把负数夹到 00:00.00
  function elapsed(now) { return now - startTime - timeBonusMs; }

  // ==================== 游戏流程 ====================
  function enterMaze() {
    state = ST.PLAYING;
    px = 1; py = 1;
    steps = 0;
    startTime = performance.now();
    hold = null;
    pressedKeys.length = 0;
    resetCombat();
    placeTreasures();    // 岔路尽头放宝物（要用到 exitI，所以在 findExit 之后）
    spawnEnemies();      // 数量 = 宝物数：终点 1 只 + 其余一个宝物 1 只；宝物必须先放好
    walked[1 * N + 1] = 1;
    // 路线总结的有序轨迹从起点开始；每局重新生成时 applyMapSize 已清过一次
    walkTrail.length = 0;
    walkBreaks.length = 0;
    walkTrail.push(1 * N + 1);
    clampCam();
    resetFog();   // 迷雾立即生效：进来只剩身周一小块视野，整图不给看

    // 先解除遮罩再动别的 UI：万一后面任何一步出异常，也不会把画面锁在黑屏上
    showOnly(null);
    hud.classList.add('show');
    fit();          // HUD 是浮层、不占高度；重算一次，画面尺寸与开始界面保持一致
    hudSteps.textContent = '0 步';
    hudTime.textContent = '00:00.00';
    syncHearts();

    beep(660, 0.09, 'triangle', 0.05);
    setTimeout(function () { beep(880, 0.1, 'triangle', 0.04); }, 90);
  }

  function tryMove(dx, dy) {
    if (state !== ST.PLAYING) return;
    var nx = px + dx, ny = py + dy;
    if (!inBounds(nx, ny) || grid[ny * N + nx] === 1) {
      bump = { dx: dx, dy: dy, until: performance.now() + CFG.BUMP_MS };
      beep(110, 0.06, 'sawtooth', 0.035);
      return;
    }
    lastCell = py * N + px;    // 「身后」= 刚离开的那一格
    px = nx; py = ny;
    steps++;
    hudSteps.textContent = steps + ' 步';
    var here = py * N + px;
    walked[here] = 1;
    walkTrail.push(here);      // 路线回放：一次移动 = 轨迹里一格
    clampCam();
    rebuildFog();
    beep(520 + Math.random() * 40, 0.03, 'square', 0.022);
    collectTreasureAt(here);   // 人与宝物重叠即收集
    // 收集可能触发随机传送 / 直接判负，所以这里统一按「当前位置 + 当前状态」再判通关
    if (state === ST.PLAYING && py * N + px === exitI) winGame();
  }

  function winGame() {
    state = ST.WIN;
    hold = null;
    if (qte) closeQte();
    clearWarn();
    var spend = elapsed(performance.now());
    hudTime.textContent = fmt(spend);
    winTime.textContent = fmt(spend);
    winSteps.textContent = steps;
    winChests.textContent = chestStats();
    hideToast();          // 结算页留白：通关不是拾取宝物触发的，别让提示压在统计上
    hud.classList.remove('show');
    showOnly(ovWin);
    [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
      setTimeout(function () { beep(f, 0.16, 'triangle', 0.055); }, i * 105);
    });
  }

  // ==================== 路线总结（交给独立模块 maze-route.js） ====================
  // 主游戏只负责递一份本局快照，绘制 / 回放 / 统计全在新模块里。
  // 以后换展示方案、加导出或分享，都不用再动这个文件。
  function routeSnapshot(returnTo) {
    return {
      N: N, SIZE: SIZE, grid: grid, bgc: bgc,   // 传引用：100×100 的地图也才 10KB
      ver: VER,                                 // 版本只有 maze.js 一处真源
      trail: walkTrail.slice(), breaks: walkBreaks.slice(),
      solution: traceBfsPath(1 * N + 1, exitI),  // 取不到时由模块归一化成 []
      startI: 1 * N + 1, exitI: exitI,
      treasures: treasures.map(function (t) { return { i: t.i, got: t.got }; }),
      steps: steps, won: state === ST.WIN, mapSize: mapSize,
      returnTo: returnTo,
      onClose: function (el) { showOnly(el); }
    };
  }

  function openRoute(returnTo) {
    if (!window.MazeRoute || exitI < 0) return;
    showOnly(ovRoute);        // 先让遮罩可见，路线模块的 canvas 才量得到宽度
    window.MazeRoute.open(routeSnapshot(returnTo));
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
    walkTrail.length = 0;
    walkBreaks.length = 0;
    camX = 0; camY = 0;
    startTime = 0;
    renderErrorLogged = false;   // 复位渲染异常标记，重新给一次日志机会

    resetCombat();      // 敌人 / 判定 / 血量 / 救命线一并清掉
    resetTreasures();   // 宝物 / 能力 / 时间奖励一并清掉

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

  // 两个结算页各自的「查看路线」：同一个回放模块，返回时切回各自的结算页
  btnViewRoute.addEventListener('click', function () {
    ensureAudio();
    openRoute(ovWin);
  });
  btnViewRouteLose.addEventListener('click', function () {
    ensureAudio();
    openRoute(ovLose);
  });

  btnKb.addEventListener('click', function () {
    ensureAudio();
    var on = pad.classList.toggle('show');
    kbLabel.textContent = on ? '收起虚拟键盘' : '呼出虚拟键盘';
    btnKb.classList.toggle('active', on);
    // 不调用 fit()：虚拟键盘是 .side 上的绝对定位浮层，不占 flex 流，
    // 侧栏尺寸前后一致，画面尺寸自然也不变（旧实现在这里重算会把画面缩小）。
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
    if (!usable) hintNote.textContent = '整张迷宫都在画面内，出口必定可见';
    else if (hintOn) hintNote.textContent = '出口不在画面内时，边缘出现呼吸红箭头';
    // 只有「大图 + 关掉指引」时才真的藏起来，其余两种情况都显示对应说明
    hintNote.hidden = usable && !hintOn;
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
    goodBag.length = 0;          // 正面能力池随迷雾开关换一套，别把两种 key 混在一袋里
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
