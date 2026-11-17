/* ============================================================
   迷宫寻路 · 路线总结（C 方案：逐步回放）  —  独立模块
   原生 Canvas 2D，无依赖，不碰游戏主循环。

   跟主游戏的接口（照 maze-music.js / MazeAudio 的模式）：
     MazeRoute.open(snapshot)  结算页点「查看路线」时调用
     MazeRoute.close()         离开路线页时调用（停回放 + 释放快照，幂等）
     MazeRoute.resize()        fit() 之后调用（仅打开时重绘）
     MazeRoute.snapshot()      只读状态，给自动化回归用
   版本由主游戏的 routeSnapshot().ver 传进来，本模块不另存版本号（避免两处真源）。

   snapshot 全部由 maze.js 传引用 / 浅拷贝，不复制整张地图：
     { N, SIZE, grid, bgc, trail, breaks, solution, startI, exitI,
       treasures, steps, won, mapSize, ver, returnTo, onClose }
   · trail     有序格索引，含起点；breaks 是 trail 里「与上一步不相邻」的索引
               （负面宝物的随机传送造成的跳跃），回放时画成紫色虚线。
   · solution  起点→终点的唯一正确通路（完美迷宫，由主游戏 BFS 回溯给出）。
   · bgc       整张迷宫的离屏底图 canvas，直接缩放贴过来，不重画地形。
   · onClose   点「返回结算」时回调，由主游戏把遮罩切回去。

   性能：本模块只在路线页打开后才跑；主循环 render() 完全不调用它。
   回放期间每 16~90ms 重绘一个约 300px 的 canvas（长轨迹自动加速），离开页面即停。
   ============================================================ */
(function () {
  'use strict';

  var ORANGE = '#ffb347', CYAN = '#48d9ff', PURPLE = '#b98cff';
  var SPEEDS = [1, 2, 4];

  var dom = null, cfg = null, derived = null, active = false;
  var at = 0, playing = false, timer = null, speedI = 0;

  /* ==================== DOM（首次打开时才建，避免首屏白做） ==================== */
  function ensureDom() {
    if (dom) return dom;
    var root = document.getElementById('ovRoute');
    if (!root) return null;
    root.innerHTML = [
      '<div class="route-head">',
      '  <div class="route-title">路线总结<small class="rt-sub"></small></div>',
      '  <button class="btn link rt-back" type="button">← 返回结算</button>',
      '</div>',
      '<div class="route-map"><canvas class="rt-canvas"></canvas></div>',
      '<div class="route-legend">',
      '  <span><i class="lg-c"></i>正确路线</span>',
      '  <span><i class="lg-p"></i>你走的</span>',
      '  <span><i class="lg-t"></i>传送断点</span>',
      '  <span><i class="lg-d"></i>当前位置</span>',
      '</div>',
      '<div class="route-player">',
      '  <button class="route-btn rt-play" type="button" title="从第 0 步重放整段路线">▶ 播放</button>',
      '  <button class="route-btn rt-replay" type="button">↺ 重播</button>',
      '  <input class="rt-range" type="range" min="0" max="1" value="0" aria-label="回放进度">',
      '  <span class="route-num rt-num">0 / 0</span>',
      '  <button class="route-btn speed rt-speed" type="button">1×</button>',
      '</div>',
      '<div class="route-events rt-events"></div>',
      '<div class="route-kpis rt-kpis"></div>',
      '<div class="route-verdict rt-verdict"></div>'
    ].join('');

    var q = function (s) { return root.querySelector(s); };
    dom = {
      sub: q('.rt-sub'), canvas: q('.rt-canvas'), back: q('.rt-back'),
      play: q('.rt-play'), replay: q('.rt-replay'), range: q('.rt-range'),
      num: q('.rt-num'), speed: q('.rt-speed'),
      events: q('.rt-events'), kpis: q('.rt-kpis'), verdict: q('.rt-verdict')
    };

    dom.play.addEventListener('click', function () { playing ? stop() : play(); });
    dom.replay.addEventListener('click', function () { stop(); at = 0; render(); play(); });
    dom.speed.addEventListener('click', function () {
      speedI = (speedI + 1) % SPEEDS.length;
      dom.speed.textContent = SPEEDS[speedI] + '×';
      if (playing) { clearInterval(timer); timer = setInterval(tick, interval()); }
    });
    dom.range.addEventListener('input', function () {
      stop(); at = parseInt(dom.range.value, 10) || 0; render();
    });
    dom.back.addEventListener('click', function () {
      var back = cfg ? cfg.onClose : null, to = cfg ? cfg.returnTo : null;
      close();
      if (back) back(to);
    });
    return dom;
  }

  /* ==================== 数据：统计 + 事件条 ==================== */
  // 可选数组的兜底集中在 normalize()，这里不再到处写 `|| []`。
  function compute(data) {
    var N = data.N, trail = data.trail, breaks = data.breaks, sol = data.solution;
    var brSet = Object.create(null), i, j;
    for (i = 0; i < breaks.length; i++) brSet[breaks[i]] = 1;

    var onSol = new Uint8Array(N * N);
    for (i = 0; i < sol.length; i++) if (sol[i] >= 0 && sol[i] < N * N) onSol[sol[i]] = 1;

    var shortest = Math.max(0, sol.length - 1);
    var actual = data.steps;
    var extra = actual - shortest;
    var rate = shortest ? Math.round(extra / shortest * 100) : 0;

    var seen = Object.create(null);
    for (i = 0; i < trail.length; i++) seen[trail[i]] = 1;
    var repeat = trail.length - Object.keys(seen).length;

    // 事件一：连续偏离正确路线的段 = 走进岔路 / 折返。
    // wrong 是全量统计，事件条只展示前几条摘要（长局可能几十次）。
    var evs = [], segStart = -1, segLen = 0, wrong = 0;
    function flushSeg() {
      if (segStart >= 0) {
        evs.push({ step: segStart, text: segLen > 1
          ? '走进岔路，多绕 ' + segLen + ' 步'
          : '走进岔路，1 步后折返' });
        wrong++;
      }
      segStart = -1; segLen = 0;
    }
    for (j = 1; j < trail.length; j++) {
      if (brSet[j]) { flushSeg(); continue; }   // 传送不属于「走错」，单独记
      if (!onSol[trail[j]]) {
        if (segStart < 0) segStart = j;
        segLen++;
      } else flushSeg();
    }
    flushSeg();   // 收尾，也覆盖「最后一步恰好是断点」的情况

    // 事件二：随机传送造成的断点
    for (i = 0; i < breaks.length; i++) {
      evs.push({ step: breaks[i], text: '踩到负面宝物，被随机传送' });
    }
    // 事件三：踩到宝物
    for (i = 0; i < data.treasures.length; i++) {
      if (!data.treasures[i].got) continue;
      var idx = trail.indexOf(data.treasures[i].i);
      if (idx > 0) evs.push({ step: idx, text: '拾取宝物' });
    }

    evs.sort(function (a, b) { return a.step - b.step; });
    if (evs.length > 5) evs = evs.slice(0, 5);
    evs.push({ step: trail.length - 1,
      text: data.won ? '抵达终点，通关！' : '在此倒下，本局未通关' });
    // 结果条要按步数排回正确位置（可能有事件与它同一步）
    evs.sort(function (a, b) { return a.step - b.step; });

    return {
      brSet: brSet,
      stats: { actual: actual, shortest: shortest, extra: extra, rate: rate, wrong: wrong, repeat: repeat },
      events: evs
    };
  }

  function kpiHtml(s) {
    // 传送抄近路时 extra/rate 会是负数，那是「赚了」不是警告，别再用橙色
    var diffCls = s.extra < 0 ? 'good' : 'warn';
    return [
      '<div class="route-kpi"><span>你走了</span><b>' + s.actual + ' 步</b></div>',
      '<div class="route-kpi good"><span>最短路线</span><b>' + s.shortest + ' 步</b></div>',
      '<div class="route-kpi ' + diffCls + '"><span>' + (s.extra < 0 ? '少走' : '多走') + '</span><b>' +
        (s.extra > 0 ? '+' : '') + s.extra + ' 步</b></div>',
      '<div class="route-kpi ' + diffCls + '"><span>绕路率</span><b>' + s.rate + '%</b></div>',
      '<div class="route-kpi"><span>走进岔路</span><b>' + s.wrong + ' 次</b></div>'
    ].join('');
  }

  function verdictHtml(s, data) {
    var diff = s.extra >= 0
      ? '多走 ' + s.extra + ' 步'
      : '少走 ' + (-s.extra) + ' 步（这次传送抄了近路）';
    var txt = (data.won
      ? '最短 <b>' + s.shortest + ' 步</b>，你走了 ' + s.actual + ' 步，'
      : '这一局在半路结束，最短路线 <b>' + s.shortest + ' 步</b>；') + diff + '。';
    if (s.wrong) txt += ' 回放能看清那 <b>' + s.wrong + ' 次</b>岔路折返。';
    if (data.breaks.length) txt += ' 紫色虚线是传送跳跃，不算一步。';
    return txt;
  }

  /* ==================== 回放状态 ==================== */
  function interval() {
    var total = Math.max(1, cfg.trail.length - 1);
    // 短局保持 90ms/步的手感；长局自动加快，整段回放控制在十秒量级
    return Math.max(16, Math.min(90, Math.round(9000 / total)) / SPEEDS[speedI]);
  }
  function stop() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (dom) dom.play.textContent = '▶ 播放';
  }
  function play() {
    if (!active || !cfg || cfg.trail.length < 2) return;
    var restart = at >= cfg.trail.length - 1;
    if (restart) at = 0;
    playing = true;
    dom.play.textContent = '❚❚ 暂停';
    if (timer) clearInterval(timer);
    // 立刻重画，否则「从末尾点播放」会先闪 1 帧完整轨迹才跳回起点
    if (restart) render();
    timer = setInterval(tick, interval());
  }
  function tick() {
    at++;
    if (at >= cfg.trail.length - 1) { at = cfg.trail.length - 1; stop(); }
    render();
  }

  function render() {
    if (!dom || !cfg) return;
    var last = cfg.trail.length - 1;
    at = Math.max(0, Math.min(at, last));
    dom.range.value = at;
    dom.num.textContent = at + ' / ' + last;
    var evs = dom.events.querySelectorAll('.route-ev');
    for (var i = 0; i < evs.length; i++) {
      evs[i].classList.toggle('on', parseInt(evs[i].getAttribute('data-step'), 10) <= at);
    }
    draw();
  }

  /* ==================== 绘制 ==================== */
  function draw() {
    if (!dom || !cfg) return;
    var cv = dom.canvas, cssW = cv.clientWidth;
    if (!cssW) return;                       // 遮罩还没显示，等 resize() 补画
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = Math.max(1, Math.round(cssW * dpr));
    if (cv.width !== W || cv.height !== W) { cv.width = W; cv.height = W; }
    var c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, W);

    var N = cfg.N, cell = W / N;
    function pt(idx) { return [(idx % N + 0.5) * cell, (((idx / N) | 0) + 0.5) * cell]; }
    function line(pts, color, width, alpha, glow, dash) {
      if (pts.length < 2) return;
      c.save();
      c.globalAlpha = alpha;
      c.strokeStyle = color; c.lineWidth = width;
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.setLineDash(dash || []);
      if (glow) { c.shadowColor = color; c.shadowBlur = glow; }
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
      for (var j = 1; j < pts.length; j++) c.lineTo(pts[j][0], pts[j][1]);
      c.stroke(); c.restore();
    }

    // 底图直接复用主游戏的整图离屏画布，再压暗一层让路线跳出来
    try { c.drawImage(cfg.bgc, 0, 0, cfg.SIZE, cfg.SIZE, 0, 0, W, W); }
    catch (e) { c.fillStyle = '#101a16'; c.fillRect(0, 0, W, W); }
    c.fillStyle = 'rgba(2,6,4,.28)';   // 只轻压一层，通路灰要留得住，路线才不糊在墙上
    c.fillRect(0, 0, W, W);

    // 正确路线画成更宽的淡青光带、玩家轨迹画成细橙线：
    // 走对了 = 青边橙芯，走错了 = 只剩橙线，没走的正确路段 = 只剩青带。
    // 两条线同宽时玩家一旦大致走对，青线会被完全盖住，「对比」就看不见了。
    var lw = Math.max(1.2, cell * 0.16);
    if (cfg.solution.length > 1) {
      line(cfg.solution.map(pt), CYAN, Math.max(2, cell * 0.36), .5, 0, []);
    }

    // 玩家路线：只画到当前回放步，断点用紫色虚线连
    var t = cfg.trail, upto = Math.min(at, t.length - 1), seg = [pt(t[0])];
    for (var j = 1; j <= upto; j++) {
      if (derived.brSet[j]) {
        if (seg.length > 1) line(seg, ORANGE, lw, .98, 0, []);
        line([pt(t[j - 1]), pt(t[j])], PURPLE, Math.max(1, cell * .14), .95, 0,
          [Math.max(2, cell * .3), Math.max(2, cell * .24)]);
        seg = [pt(t[j])];
      } else seg.push(pt(t[j]));
    }
    if (seg.length > 1) line(seg, ORANGE, lw, .95, Math.max(2, cell * .18), []);

    // 宝物：拾取过的亮黄，没拾取的留个淡淡的记号
    var tr = cfg.treasures, r = Math.max(1.4, cell * .26);
    for (var q = 0; q < tr.length; q++) {
      var p = pt(tr[q].i);
      c.save(); c.translate(p[0], p[1]); c.rotate(Math.PI / 4);
      c.fillStyle = tr[q].got ? '#ffd45a' : 'rgba(255,212,90,.35)';
      c.shadowColor = '#ffd45a'; c.shadowBlur = tr[q].got ? Math.max(2, cell * .5) : 0;
      c.fillRect(-r, -r, r * 2, r * 2); c.restore();
    }

    // 起点白方块 / 终点红格
    var rr = Math.max(2, cell * .32), ps = pt(cfg.startI), pe = pt(cfg.exitI);
    c.save(); c.fillStyle = '#fff'; c.shadowColor = '#fff'; c.shadowBlur = Math.max(3, cell * .5);
    c.fillRect(ps[0] - rr, ps[1] - rr, rr * 2, rr * 2); c.restore();
    c.save(); c.fillStyle = '#ff2d2d'; c.shadowColor = '#ff2d2d'; c.shadowBlur = Math.max(3, cell * .7);
    c.fillRect(pe[0] - rr, pe[1] - rr, rr * 2, rr * 2); c.restore();

    // 当前位置的光点
    if (upto > 0) {
      var pc = pt(t[upto]);
      c.save(); c.fillStyle = '#fff'; c.shadowColor = '#fff'; c.shadowBlur = Math.max(4, cell * .8);
      c.beginPath(); c.arc(pc[0], pc[1], Math.max(2, cell * .32), 0, Math.PI * 2); c.fill(); c.restore();
    }
  }

  /* ==================== 对外接口 ==================== */
  // 快照只在这里归一化一次：补齐可选数组/数字，且不修改调用方传进来的对象。
  function normalize(data) {
    var out = {}, k;
    for (k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    out.trail = data.trail || [];
    out.breaks = data.breaks || [];
    out.solution = data.solution || [];
    out.treasures = data.treasures || [];
    out.steps = data.steps || 0;
    return out;
  }

  function open(data) {
    var d = ensureDom();
    if (!d || !data || !data.trail || !data.trail.length) return;
    stop();
    cfg = normalize(data);
    derived = compute(cfg);
    active = true;
    // 进来先给完整对比（用户要的是「看到两条路线」），点播放才从第 0 步重放
    at = cfg.trail.length - 1;
    speedI = 0;
    d.speed.textContent = '1×';
    // 副标题压在一行内（300px 宽）：颜色交给图例解释，「点播放」交给按钮 title
    d.sub.textContent = cfg.mapSize + '×' + cfg.mapSize + ' 迷宫 · ' +
      (cfg.won ? '已通关' : '未通关');
    d.range.max = at;
    d.events.innerHTML = derived.events.map(function (e) {
      return '<div class="route-ev" data-step="' + e.step + '"><b>第 ' + e.step + ' 步</b><span>' + e.text + '</span></div>';
    }).join('');
    d.kpis.innerHTML = kpiHtml(derived.stats);
    d.verdict.innerHTML = verdictHtml(derived.stats, cfg);
    render();                   // 内部会把 range/num/事件高亮/地图一次同步到位
    // 首帧布局可能还没稳定，下一帧补画一次
    requestAnimationFrame(function () { if (active) draw(); });
  }

  function close() {
    stop();
    active = false;
    // 释放对上一局 grid / bgc 的引用：重开一局后它们已经失效，别让模块一直攥着
    cfg = null;
    derived = null;
  }

  function resize() { if (active) draw(); }

  function snapshot() {
    return {
      ver: cfg ? (cfg.ver || '-') : '-',
      active: active, at: at, playing: playing, speed: SPEEDS[speedI],
      trailLen: cfg ? cfg.trail.length : 0,
      solutionLen: cfg ? cfg.solution.length : 0,
      breaks: cfg ? cfg.breaks.slice() : [],
      won: cfg ? cfg.won : null,
      stats: derived ? derived.stats : null,
      events: derived ? derived.events.map(function (e) { return { step: e.step, text: e.text }; }) : []
    };
  }

  window.MazeRoute = { open: open, close: close, resize: resize, snapshot: snapshot };
})();
