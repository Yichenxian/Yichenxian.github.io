/* ============================================================
   合作逃生 · 主控 / 房主唯一权威结算
   intro → lobby → abilities → playing → review → lobby
   ============================================================ */

import {
  N, idx, inBounds, CFG, unpackGrid, hashGrid
} from './escape-map.js?v=20261113r';
import { computeSight, centerCam, FOG_SIGHT, FOG_PEEK } from './escape-fog.js?v=20261113r';
import { tickMonster, publicMonster } from './escape-ai.js?v=20261113r';
import { tickBots } from './escape-bot.js?v=20261113r';
import { createRenderer } from './escape-render.js?v=20261113r';
import { createUI } from './escape-ui.js?v=20261113r';
import { createSfx } from './escape-sfx.js?v=20261113r';
import {
  createNet, createSoloNet, parseQuery, normalizeRoomId, GAME0
} from './escape-net.js?v=20261113r';
import { createAuthority, INVULN_MS } from './escape-authority.js?v=20261113r';

const STEP_MS = 160;      // 每格间隔（约 6 格/秒）
const PUSH_MS = 50;
const SIGHT_TICK_MS = 200;

/* 人机队友的名册：id 用 ai1/ai2/ai3，与 trystero 的长 hex userId 不会撞 */
const BOT_META = [
  { id: 'ai1', name: '人机 1', color: '#ff9f43' },
  { id: 'ai2', name: '人机 2', color: '#00d2d3' },
  { id: 'ai3', name: '人机 3', color: '#b066ff' }
];

const DIR_BY_NAME = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const DIR_BY_VEC = { '0,-1': 'up', '1,0': 'right', '0,1': 'down', '-1,0': 'left' };
const KEYMAP = {
  w: [0, -1], W: [0, -1], ArrowUp: [0, -1],
  s: [0, 1], S: [0, 1], ArrowDown: [0, 1],
  a: [-1, 0], A: [-1, 0], ArrowLeft: [-1, 0],
  d: [1, 0], D: [1, 0], ArrowRight: [1, 0]
};

const q = parseQuery();
const ui = createUI();
const sfx = createSfx();
const net = q.solo ? createSoloNet() : createNet();
const renderer = createRenderer(ui.els.cv);

let selfId = '';
let joined = false;
let phase = 'intro';
let viewGame = Object.assign({}, GAME0);
let profiles = {};
let grid = null;
let mapHash = '';
let lastSight = null;
let lobbyStatus = '创建房间并邀请队友；人数不够可以先添加人机补位。';
let strategy = q.strategy || 'nostr';
let relayUrl = '';

/* ---------------- 免费穿透：TURN 开关 ----------------
   默认开；公共 TURN 只在直连打不通时才被 ICE 选中，正常对局不会变慢。
   ?turn=0 关掉；?turn=turn:h:3478,turns:h:5349&turnuser=&turnpass= 换自建服务器 */
let turnUrls = q.turnUrls, turnUser = q.turnUser, turnPass = q.turnPass;
if (q.turnOff) ui.setTurnOn(false);
function iceOpts() {
  return { turn: ui.getTurnOn(), turnUrls: turnUrls, turnUser: turnUser, turnPass: turnPass };
}
let netCheckBusy = false;

/* ---------------- 断线续玩：把房间记在本地 ----------------
   刷新后 userId 不变（trystero 的 'local' 身份存在 IndexedDB 里），所以客端重进
   能拿回同一个座位；房主复用短码也能重建出与刷新前**完全相同**的 roomId。 */
const ROOM_KEY = 'escape_room';
const ROOM_TTL = 6 * 3600 * 1000;   // 超过 6 小时就别再拿旧房间号骚扰人了

function saveRoom() {
  if (!net.fullRoomId) return;
  // 单机调试的房间号（escape-000000~solo0）别人进不来，别记它
  if (q.solo) return;
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({
      room: net.fullRoomId, short: net.shortCode, host: !!net.isHost,
      strategy: net.strategy, relay: relayUrl, t: Date.now()
    }));
  } catch (e) { /* 隐私模式：记不住就算了 */ }
}
function clearRoom() { try { localStorage.removeItem(ROOM_KEY); } catch (e) { /* 忽略 */ } }
function loadRoom() {
  try {
    const r = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null');
    if (!r || !r.room || r.room.indexOf('~') < 0) return null;
    if (Date.now() - (r.t || 0) > ROOM_TTL) return null;
    return r;
  } catch (e) { return null; }
}

/** 大厅文案的唯一入口：lobbyStatus 与 DOM 必须同时更新，
 *  写成两行的话迟早有人只改一行，界面就停在上一句。 */
function setStatus(text) {
  lobbyStatus = text;
  ui.setLobbyStatus(text);
}
let lastAbilityRound = -1;
let revealedKeyIds = [];
let revealedFakeIds = [];
let pendingReveal = null;
let seenEvt = {};
let inputSeq = 0;
let holdDir = null, holdAt = 0, pendingWall = false;
/** 按住中的方向键（按先后顺序，最后按下的那个生效）。放在这里而不是事件绑定处，
    是因为 resetView / releaseHold 都会用到它，早声明免得踩 TDZ。 */
const pressedKeys = [];
let backArmUntil = 0;  // 音乐条右上「返回房间」的两段式确认窗口
let lastPush = 0, lastSightTick = 0, lastHud = 0, lastHudH = -1;
let botRoster = [];    // 房主维护的人机名单（大厅座位）
// 本局人机行动体在规则层（auth.bots），下面有 const botAgents = auth.bots 的别名

/* ---------------- 音效触发点用的本地观测值 ----------------
   都不参与同步：只根据「本端看到的画面」决定响什么，绝不隔墙报点。 */
const SFX_BEAT_R = 4;        // 心跳提示的最大格距（切比雪夫）
let lastStepCell = -1;       // 自己上一帧所在格，用来判定「走了一步」
let lastViewPos = null;      // 当前视角所在的格（死亡观战时是队友）
let lastBeatAt = 0;          // 上一次心跳的时间戳
let chaseHeard = false;      // 这轮追击是否已经响过「被盯上」的嘶鸣
let bumpDir = null;          // 正顶着墙的方向；同方向按住不放只响一次撞墙声

/* ---------------- 房主权威状态 ----------------
   规则本体（开局 / 扣血 / 判定结束 / 复盘数字）在 escape-authority.js，
   这里只做一次性接线。A 与 botAgents 都是**稳定引用**（规则层就地重置、
   只 push/清空），所以下面所有 A.xxx 的读写都不用改。 */
const auth = createAuthority({
  isHost: () => net.isHost,
  joined: () => joined,
  selfId: () => selfId,
  userIds: () => userIds(),
  toast: text => ui.toast(text),
  botInfo: id => botInfo(id),
  isBotId: id => isBotId(id),
  colorOf: id => colorOf(id),
  shortName: id => shortName(id),
  // 开局要把新地图交给渲染层，并把客端的上一局残留清干净
  syncMap: (g, h) => { grid = g; mapHash = h; },
  resetView: () => {
    seenEvt = {};
    lastAbilityRound = -1;
    revealedKeyIds = [];
    revealedFakeIds = [];
    pendingReveal = null;
    seenUsers = {};
  },
  handleReveal: d => handleReveal(d),
  sendReveal: (id, d) => net.sendReveal(id, d),
  publish: () => publish(),
  emit: e => emitEvent(e)
});
const A = auth.A;
const botAgents = auth.bots;

function clonePlayers(src) {
  const out = {};
  Object.keys(src).forEach(id => { out[id] = Object.assign({}, src[id]); });
  return out;
}

function publicGame() {
  return {
    phase: A.phase, roundId: A.roundId, hostUserId: net.hostUserId,
    size: N,
    mapB64: A.info ? A.info.mapB64 : '',
    mapHash: A.info ? A.info.mapHash : '',
    keys: A.info ? A.info.keys.slice() : [],
    realTotal: A.info ? A.info.realTotal : 0,
    fakeTotal: A.info ? A.info.fakeTotal : 0,
    realTaken: A.realTaken, fakePicked: A.fakePicked,
    taken: Object.assign({}, A.taken),
    exitI: A.info ? A.info.exitI : -1,
    exitActive: A.exitActive,
    monsterHomeI: A.info ? A.info.monsterHomeI : -1,
    spawns: A.info ? A.info.spawns.map(s => ({ x: s.x, y: s.y })) : [],
    abilities: Object.assign({}, A.abilities),
    allyUnlocked: A.allyUnlocked,
    players: clonePlayers(A.players),
    bots: botRoster.map(b => ({ id: b.id, name: b.name, color: b.color })),
    monster: A.monster ? publicMonster(A.monster) : { x: 0, y: 0, st: 'wander', target: null },
    startedAt: A.startedAt, keysDoneAt: A.keysDoneAt, endedAt: A.endedAt, win: A.win,
    stats: Object.assign({}, A.stats),
    review: A.review
  };
}

function publish() {
  const g = publicGame();
  viewGame = g;
  net.setGame(g);
  // 还没进房（joined=false）时只刷新本地快照，别把大厅顶回开场页
  if (joined) syncPhase();
}

/* ---------------- 断线重进：补发定向数据 ----------------
   只发给「这一下才出现」的账号：onUsers 会被 profile 变色/关卡片等频繁触发，
   不加这个去重就会一直重发 keyIds/fakeIds。 */
let seenUsers = {};
function resendReveals(users) {
  const now = users || {};
  if (net.isHost && A.reveals && (A.phase === 'playing' || A.phase === 'abilities')) {
    const ids = Object.keys(now);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!seenUsers[id] && A.reveals[id]) net.sendReveal(id, A.reveals[id]);
    }
  }
  seenUsers = Object.assign({}, now);
}

/* ---------------- 地图解包与校验 ---------------- */
function ensureGrid(v) {
  if (!v.mapB64) { grid = null; mapHash = ''; return; }
  if (net.isHost && A.grid) { grid = A.grid; mapHash = v.mapHash; return; }
  if (grid && v.mapHash === mapHash) return;
  const g = unpackGrid(v.mapB64);
  if (hashGrid(g) !== v.mapHash) {
    ui.toast('地图校验失败，正在重新同步');
    net.requestSync();
  }
  grid = g;
  mapHash = v.mapHash;
}

/* ---------------- 页面状态 ---------------- */
/** 「返回房间」只对房主、且只在局内（能力页 / 进行中）有意义 */
function updateBackRoomBtn() {
  ui.setBackRoom(!!joined && net.isHost && (phase === 'playing' || phase === 'abilities'));
}

function setPhase(name) {
  const wasPlaying = phase === 'playing';
  phase = name;
  ui.showOnly(name);
  if (name === 'lobby') renderLobby();
  if (name === 'abilities') renderAbility();
  if (name === 'review') ui.showReview(viewGame.review || auth.emptyReview());
  if (name === 'playing') {
    renderHUD();
    resetSfxTrackers();
    sfx.play('start');       // 「可以动了」——每个客户端都会走到这里，不必依赖 START 事件
    // 立刻画一帧：帧循环只在局内画，若等下一帧才画，切进对局会闪一下黑，
    // 而且 lastSight 要到这里才有值（tickDanger 与 EscapeDebug.lit 都读它）
    renderFrame(performance.now());
  } else if (wasPlaying) {
    // 离开局内：松掉按住的方向，并撤销「下一次移动穿墙」的预约。
    // 否则在大厅/结算期间点过穿墙、或按着方向键被结算，状态会带进下一局。
    releaseHold();
    pendingWall = false;
  }
  // 局内按钮（穿墙 / 抢救 / 观战切换）只在 phase === 'playing' 出现，阶段一变就重算。
  // 原来只有 playing 分支和帧循环会刷新，结束 → 复盘 → 回大厅后没人再调，
  // 按钮就一直挂在 .side 上（遮罩只盖 .stagewrap，盖不到 .side）。
  renderButtons();
  updateBackRoomBtn();
}

function targetPhase() {
  if (!joined) return 'intro';
  const p = viewGame.phase;
  if (p === 'abilities') return 'abilities';
  if (p === 'playing') return 'playing';
  if (p === 'review') return 'review';
  return 'lobby';
}

function syncPhase() {
  const t = targetPhase();
  if (t === phase) {
    if (phase === 'abilities') renderAbility();
    return;
  }
  if (t === 'abilities') {
    if (viewGame.roundId !== lastAbilityRound) {
      lastAbilityRound = viewGame.roundId;
      net.setProfile({ closed: false, closedRound: 0, spectateTo: null });
    }
    seenEvt = {};
  }
  if (t === 'lobby' && (phase === 'playing' || phase === 'abilities')) {
    // 房主中途「返回房间」：客端也要跟着回大厅，并告诉他为什么这局没了
    lobbyStatus = net.isHost
      ? '回到房间，等待房主再次开始。'
      : '房主已中止本局，全队回到房间。';
  }
  setPhase(t);
  if (net.isHost && t === 'abilities') checkAbilitiesClosed();
}

/** 退出 / 掉线后的统一收尾：清掉一切「属于这一间房」的临时状态。
 *  漏清会跨房间串味 —— 比如 pendingReveal 带着上一局的 roundId，
 *  正好命中新一局同样是 1 的 roundId，就会先闪一帧别人的钥匙位置。 */
function resetSession(status) {
  joined = false;
  profiles = {};
  viewGame = Object.assign({}, GAME0);
  grid = null; mapHash = '';
  lastSight = null;
  botRoster = []; auth.bots.length = 0;
  seenUsers = {};
  lastAbilityRound = -1;
  revealedKeyIds = []; revealedFakeIds = [];
  pendingReveal = null;
  seenEvt = {};
  holdDir = null; holdAt = 0; pendingWall = false;
  pressedKeys.length = 0;
  lastViewPos = null;
  resetSfxTrackers();
  clearRoom();
  ui.setResume('', '');
  setStatus(status);
  setPhase('lobby');
}

function myAbility() { return viewGame.abilities[selfId] || 0; }
function ownProfile() { return profiles[selfId] || {}; }

/* ---------------- 人机名册 ---------------- */
// 房主读本地名册（建房前后都有效），客端读广播过来的 game.bots
function botList() {
  const list = net.isHost ? botRoster : (viewGame.bots || []);
  return list || [];
}
function botInfo(id) {
  const list = botList();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function isBotId(id) { return !!botInfo(id); }
function botCount() { return botList().length; }

function colorOf(id) {
  const b = botInfo(id);
  if (b) return b.color;
  return (profiles[id] || {}).color || '#ffffff';
}
function shortName(id) {
  const b = botInfo(id);
  if (b) return b.name;
  if (id === selfId) return ui.getName() || '我';
  // 队友在开场页填的名字：飘字、座位、复盘都走这里，所以一处改动全链路生效
  const p = profiles[id];
  const n = p && String(p.name || '').trim();
  return n || String(id).slice(0, 6);
}

function userIds() {
  // 还没进房时自己不算座位：否则「开始游戏」会在 selfId 还没赋值时被点下去
  const out = joined ? [selfId] : [];
  const users = Object.keys(net.getUsers());
  for (let i = 0; i < users.length; i++) if (out.indexOf(users[i]) < 0) out.push(users[i]);
  const list = botList();
  for (let i = 0; i < list.length; i++) if (out.indexOf(list[i].id) < 0) out.push(list[i].id);
  return out;
}

/* ---------------- 房主人机席位维护 ---------------- */
function addBot() {
  if (!net.isHost || phase !== 'lobby') return;
  if (userIds().length >= 4) { ui.toast('座位已满'); return; }
  const used = botRoster.map(b => b.id);
  let meta = null;
  for (let i = 0; i < BOT_META.length; i++) {
    if (used.indexOf(BOT_META[i].id) < 0) { meta = BOT_META[i]; break; }
  }
  if (!meta) return;
  botRoster.push({ id: meta.id, name: meta.name, color: meta.color });
  lobbyStatus = '已添加' + meta.name + '，人机可补位开局。';
  publish();
  renderLobby();
}

function removeBot() {
  if (!net.isHost || phase !== 'lobby' || !botRoster.length) return;
  const last = botRoster.pop();
  lobbyStatus = '已移除' + last.name + '。';
  publish();
  renderLobby();
}

/** 真人进房后把人机从队尾挤掉，保证总人数不超过 4 */
function trimBots() {
  if (!net.isHost) return false;
  const humans = 1 + Object.keys(net.getUsers()).length;
  let changed = false;
  while (botRoster.length && humans + botRoster.length > 4) { botRoster.pop(); changed = true; }
  return changed;
}

function renderLobby() {
  const ids = userIds();
  const users = ids.map(id => {
    const bot = botInfo(id);
    return {
      self: id === selfId,
      host: id === net.hostUserId,
      bot: !!bot,
      short: shortName(id),
      color: colorOf(id)
    };
  });
  const bots = botCount();
  ui.renderLobby({
    roomCode: net.shortCode || '------',
    roomId: net.fullRoomId,
    isHost: net.isHost,
    userCount: ids.length,
    canStart: net.isHost && ids.length === 4,
    canAddBot: net.isHost && ids.length < 4,
    canRemoveBot: net.isHost && bots > 0,
    botCount: bots,
    users,
    status: lobbyStatus
  });
}

function renderAbility() {
  const ids = userIds();
  const closed = ownProfile().closed && ownProfile().closedRound === viewGame.roundId;
  let count = 0;
  ids.forEach(id => {
    if (isBotId(id)) { count++; return; }          // 人机自动确认
    const p = profiles[id];
    if (p && p.closed && p.closedRound === viewGame.roundId) count++;
  });
  ui.renderAbility({ ability: myAbility(), closed, closedCount: count });
}

function checkAbilitiesClosed() {
  if (!net.isHost || A.phase !== 'abilities') return;
  const ids = userIds();
  if (ids.length !== 4) return;
  for (let i = 0; i < ids.length; i++) {
    if (isBotId(ids[i])) continue;                 // 人机不需要关弹窗
    const p = profiles[ids[i]];
    if (!p || !p.closed || p.closedRound !== A.roundId) return;
  }
  A.phase = 'playing';
  A.startedAt = Date.now();
  A.endedAt = 0;
  publish();
  emitEvent({ type: 'START' });
}

/* 开局 / 扣血 / 判定结束 / 复盘数字 → escape-authority.js（规则层） */

function wallLanding(x, y, dx, dy) {
  let wallSeen = false;
  for (let k = 1; k <= 6; k++) {
    const xx = x + dx * k, yy = y + dy * k;
    if (!inBounds(xx, yy)) return null;
    const i = idx(xx, yy);
    if (A.grid[i] === 1) {
      if (wallSeen) return null;
      wallSeen = true;
      continue;
    }
    if (wallSeen) return { x: xx, y: yy };
    return null;   // 前方本来就是通路，不消耗次数
  }
  return null;
}

function tryMove(u, d) {
  if (A.phase !== 'playing') return;
  const p = A.players[u];
  if (!p || !p.alive) return;
  const dir = DIR_BY_NAME[d.dir];
  if (!dir) return;
  let nx = p.x + dir[0], ny = p.y + dir[1];

  if (d.wall && A.abilities[u] === 4 && p.wallCharges > 0) {
    const land = wallLanding(p.x, p.y, dir[0], dir[1]);
    if (land) {
      nx = land.x; ny = land.y;
      p.wallCharges--;
      p.wallUses++;
      emitEvent({ type: 'WALL_USE', userId: u, chargesAfter: p.wallCharges });
    }
  }
  if (!inBounds(nx, ny) || A.grid[idx(nx, ny)] === 1) return;
  p.x = nx; p.y = ny;
  collectKey(u, idx(nx, ny));
  auth.checkEnd();
}

function collectKey(u, cellI) {
  const k = A.info.keys.indexOf(cellI);
  if (k < 0 || A.taken[k]) return;
  A.taken[k] = u;
  const p = A.players[u];
  const real = A.map.keys[k].real;
  if (real) {
    A.realTaken++;
    p.keysReal++;
    if (p.hp < CFG.HP_MAX) p.hp++;
    if (A.abilities[u] === 4) p.wallCharges++;
    if (!A.allyUnlocked && A.realTaken >= CFG.ALLY_UNLOCK) {
      A.allyUnlocked = true;
      emitEvent({ type: 'ALLY_UNLOCK' });
    }
    if (!A.exitActive && A.realTaken >= A.info.realTotal) {
      A.exitActive = true;
      A.keysDoneAt = Date.now();
      emitEvent({ type: 'EXIT_ACTIVE' });
    }
    emitEvent({ type: 'KEY_PICK', userId: u, real: true, keyIndex: k });
  } else {
    A.fakePicked++;
    p.keysFake++;
    emitEvent({ type: 'KEY_PICK', userId: u, real: false, keyIndex: k });
    auth.damage(u, 'fake');
  }
}

/* 扣血 → escape-authority.js */
function tryRevive(by, target) {
  if (A.phase !== 'playing') return;
  const p = A.players[by], t = A.players[target];
  if (!p || !p.alive || !t || t.alive || t.reviveUsed) return;
  if (p.x !== t.x || p.y !== t.y) return;
  t.reviveUsed = true;
  t.alive = true;
  t.hp = 1;
  t.invulnUntil = Date.now() + INVULN_MS;
  A.stats.reviveCount++;
  emitEvent({ type: 'REVIVE', byUserId: by, targetUserId: target, hpAfter: 1 });
  publish();
}

/* 判定结束 / 复盘数字 / 收尾 → escape-authority.js */

/* ---------------- 事件（飘字 / 音效提示） ---------------- */
function emitEvent(evt) {
  A.evtId++;
  evt.evtId = A.evtId;
  evt.roundId = A.roundId;
  handleEvent(evt);
  net.sendEvent(evt);
}

function handleEvent(evt) {
  if (!evt || evt.roundId !== viewGame.roundId) return;
  if (seenEvt[evt.evtId]) return;
  seenEvt[evt.evtId] = 1;
  const who = shortName(evt.userId || evt.targetUserId || '');
  switch (evt.type) {
    case 'KEY_PICK':
      if (evt.real) ui.toast('真钥匙 +1（' + viewGame.realTaken + ' / ' + viewGame.realTotal + '）');
      else ui.toast('假钥匙！' + who + ' 掉 1 血');
      sfx.play(evt.real ? 'key' : 'fake');
      break;
    case 'DAMAGE':
      ui.toast(who + (evt.cause === 'monster' ? ' 被怪物撞到' : ' 受伤'));
      sfx.play(evt.cause === 'monster' ? 'hit_monster' : 'hurt');
      break;
    case 'DEATH': ui.toast(who + ' 倒下了' + (evt.reviveUsed ? '（只能观战）' : '，可抢救')); sfx.play('death'); break;
    case 'REVIVE': ui.toast('抢救成功，' + who + ' 复活'); sfx.play('revive'); break;
    case 'WALL_USE': ui.toast('穿透墙壁，剩余 ' + evt.chargesAfter + ' 次'); sfx.play('wall'); break;
    case 'ALLY_UNLOCK': ui.toast('队友位置已解锁'); sfx.play('unlock'); break;
    case 'EXIT_ACTIVE': ui.toast('钥匙集齐！全员前往终点'); sfx.play('exit'); break;
    case 'WIN': sfx.play('win'); break;
    case 'LOSE': sfx.play('lose'); break;
    default: break;
  }
}

function handleReveal(d) {
  if (!d) return;
  // 定向消息可能比 game 状态先到，先缓存，等轮次对上再生效
  if (d.roundId !== viewGame.roundId) { pendingReveal = d; return; }
  pendingReveal = null;
  revealedKeyIds = d.keyIds || [];
  revealedFakeIds = d.fakeIds || [];
}

function handleInput(d, ctx) {
  if (!net.isHost || A.phase !== 'playing') return;
  const u = ctx && ctx.userId;
  if (!u || !A.players[u]) return;
  if (d.roundId !== A.roundId || d.seq <= (A.lastSeq[u] || 0)) return;
  A.lastSeq[u] = d.seq;
  if (d.action === 'move') tryMove(u, d);
  else if (d.action === 'revive') tryRevive(u, d.target);
}

/* ---------------- HUD 与按钮 ---------------- */
function renderHUD() {
  const me = viewGame.players[selfId];
  const elapsed = viewGame.startedAt
    ? ((viewGame.endedAt || Date.now()) - viewGame.startedAt) : 0;
  ui.renderHUD({
    hp: me ? me.hp : 0,
    alive: me ? me.alive : false,
    realTaken: viewGame.realTaken,
    realTotal: viewGame.realTotal,
    ability: myAbility(),
    elapsed,
    roomCode: net.shortCode || '--'
  });
}

function renderButtons() {
  const inGame = phase === 'playing';
  const me = viewGame.players[selfId];
  const alive = !!(me && me.alive);
  let reviveTarget = null;
  if (inGame && alive) {
    Object.keys(viewGame.players).forEach(id => {
      const p = viewGame.players[id];
      if (!p.alive && !p.reviveUsed && p.x === me.x && p.y === me.y) reviveTarget = id;
    });
  }
  ui.renderButtons({
    showWall: inGame && alive && myAbility() === 4,
    wallCharges: me ? me.wallCharges : 0,
    showRevive: !!reviveTarget,
    reviveName: reviveTarget ? shortName(reviveTarget) : '',
    spectating: inGame && !alive
  });
}

/* ---------------- 渲染 ---------------- */
function renderFrame(now) {
  // 只有局内才画：大厅 / 能力页 / 结算页全被 94% 不透明遮罩盖着，
  // 这时候每帧跑 computeSight + 整图绘制纯属烧电（手机上是实打实的耗电）。
  // 顺手把 lastSight 清掉，免得下一局第一帧的 tickDanger 读到上一局的视野。
  if (phase !== 'playing') { lastSight = null; return; }
  if (!grid || !viewGame.players || !Object.keys(viewGame.players).length) return;
  const me = viewGame.players[selfId];
  let viewId = selfId;
  if (me && !me.alive) {
    const spec = ownProfile().spectateTo;
    const aliveIds = Object.keys(viewGame.players).filter(id => viewGame.players[id].alive);
    viewId = (spec && viewGame.players[spec] && viewGame.players[spec].alive)
      ? spec : (aliveIds[0] || selfId);
  }
  const vp = viewGame.players[viewId] || { x: 1, y: 1 };
  const sight = computeSight(grid, vp.x, vp.y, FOG_SIGHT, FOG_PEEK);
  lastSight = sight;
  const cam = centerCam(vp.x, vp.y);
  const ids = Object.keys(viewGame.players);
  renderer.draw({
    grid, sight, mapHash: viewGame.mapHash,
    camX: cam.camX, camY: cam.camY, px: vp.x, py: vp.y,
    viewId,
    players: ids.map(id => {
      const p = viewGame.players[id];
      return { id, x: p.x, y: p.y, color: colorOf(id), alive: p.alive, bot: isBotId(id) };
    }),
    keys: viewGame.keys.map((i, k) => ({ i, taken: !!viewGame.taken[k] })),
    fakeIds: revealedFakeIds,
    distinguish: myAbility() === 2,
    keyBeacons: myAbility() === 1,
    revealAll: myAbility() === 3,
    exitI: viewGame.exitI,
    exitActive: viewGame.exitActive,
    monster: viewGame.monster,
    allyUnlocked: viewGame.allyUnlocked,
    now
  });
  lastViewPos = { x: vp.x, y: vp.y };
}

/* ---------------- 音效：本地触发点 ---------------- */
function resetSfxTrackers() {
  lastStepCell = -1;
  lastBeatAt = 0;
  chaseHeard = false;
  bumpDir = null;
}

/** 自己的脚步声。用「位置有没有变」判定：客端的移动由房主裁决，
    本地没有 tryMove 可以挂钩，只有广播回来的坐标是可信的。 */
function tickSelfStep() {
  const me = viewGame.players[selfId];
  if (!me || !me.alive) { lastStepCell = -1; return; }
  const c = idx(me.x, me.y);
  if (lastStepCell < 0) { lastStepCell = c; return; }   // 首帧只记基线
  if (c === lastStepCell) return;
  lastStepCell = c;
  bumpDir = null;                                      // 走动起来了，下次撞墙重新响
  sfx.play('step');
}

/** 撞墙预判：地图是全量下发的（迷雾只影响可见性，不影响 grid），所以客户端能
    在按键的这一帧就知道「前面是墙」，不用等房主驳回 —— 手感上必须是零延迟。
    同方向按住不放只响第一下，换方向或真走动了才重置。 */
function predictBump(dir) {
  const me = viewGame.players[selfId];
  if (!me || !me.alive || !grid) return;
  const v = DIR_BY_NAME[dir];
  const nx = me.x + v[0], ny = me.y + v[1];
  const blocked = !inBounds(nx, ny) || grid[idx(nx, ny)] === 1;
  if (!blocked) { bumpDir = null; return; }
  if (bumpDir === dir) return;
  bumpDir = dir;
  sfx.play('bump');
}

/** 怪物临场感：心跳只在「怪物真的出现在自己视野里」时才响 —— lit 就是可见性真源，
    隔墙绝不报点，否则等于白送一个全图透视。 */
function tickDanger(now) {
  const m = viewGame.monster;
  const seen = !!(m && lastSight && lastSight.lit && lastSight.lit[idx(m.x, m.y)] && lastViewPos);
  // 被盯上：怪物切进追击且目标是我，且我确实看得见它（看得见才响，规则同心跳）
  const chasing = seen && m.st === 'chase' && m.target === selfId;
  if (chasing && !chaseHeard) { chaseHeard = true; sfx.play('chase'); }
  if (!chasing) chaseHeard = false;
  if (!seen) return;

  const d = Math.max(Math.abs(m.x - lastViewPos.x), Math.abs(m.y - lastViewPos.y));
  if (d > SFX_BEAT_R) return;
  // 越近越急：四档间隔，给玩家一个「还有几格」的听觉刻度
  const gap = d <= 1 ? 460 : (d <= 2 ? 640 : (d <= 3 ? 820 : 1000));
  if (now - lastBeatAt < gap) return;
  lastBeatAt = now;
  sfx.play('heart');
}

/* ---------------- 主循环 ---------------- */
function tickInput(now) {
  if (!holdDir || phase !== 'playing') return;
  if (now - holdAt < STEP_MS) return;
  holdAt = now;
  const dir = DIR_BY_VEC[holdDir[0] + ',' + holdDir[1]];
  if (!dir) return;
  const wall = pendingWall;
  pendingWall = false;
  // 穿墙这一下不算撞墙：它就是要穿过那堵墙，响了反而像失败
  if (!wall) predictBump(dir);
  net.sendInput({ roundId: viewGame.roundId, seq: ++inputSeq, dir, wall, action: 'move' });
}

function tickAbilitySight() {
  if (!A.grid || !A.map) return;
  Object.keys(A.players).forEach(id => {
    const p = A.players[id];
    if (!p.alive || A.abilities[id] !== 2) return;
    const sight = computeSight(A.grid, p.x, p.y, FOG_SIGHT, FOG_PEEK);
    A.map.fakeIds.forEach(f => {
      if (A.taken[f] || p.seenFakes.indexOf(f) !== -1) return;
      if (sight.lit[A.info.keys[f]]) p.seenFakes.push(f);
    });
  });
}

/* ---------------- 人机：房主单端推进 ---------------- */
/** 场上还剩哪些真钥匙（假钥匙不告诉人机，人机也不会主动去捡） */
function botTargetsHost() {
  const out = [];
  if (!A.info || !A.map) return out;
  for (let k = 0; k < A.info.keys.length; k++) {
    if (A.taken[k]) continue;
    if (!A.map.keys[k].real) continue;
    out.push(A.info.keys[k]);
  }
  return out;
}

/** 终点已激活且已经站了真人 → 人机不再躲怪，直接冲终点汇合 */
function humanAtExit() {
  if (!A.info || !A.exitActive || A.info.exitI < 0) return false;
  const ids = Object.keys(A.players);
  for (let i = 0; i < ids.length; i++) {
    if (isBotId(ids[i])) continue;
    const p = A.players[ids[i]];
    if (p && p.alive && idx(p.x, p.y) === A.info.exitI) return true;
  }
  return false;
}

function tickBotsHost(now) {
  if (!botAgents.length || !A.grid || !A.info) return;
  const alive = [];
  for (let i = 0; i < botAgents.length; i++) {
    const b = botAgents[i];
    const p = A.players[b.id];
    if (!p || !p.alive) continue;
    b.x = p.x; b.y = p.y;          // 以权威格位为准（被抢救复活后仍对齐）
    alive.push(b);
  }
  if (!alive.length) return;
  const moved = tickBots(alive, {
    grid: A.grid,
    targets: botTargetsHost(),
    exitI: A.info.exitI,
    exitActive: A.exitActive,
    playerAtExit: humanAtExit(),
    monster: A.monster ? { x: A.monster.x, y: A.monster.y } : null
  }, now);
  for (let i = 0; i < moved.length; i++) {
    const b = moved[i];
    const p = A.players[b.id];
    p.x = b.x; p.y = b.y;
    collectKey(b.id, idx(b.x, b.y));
  }
}

function loop(now) {
  requestAnimationFrame(loop);
  if (phase === 'playing') {
    tickInput(now);
    tickSelfStep();
    tickDanger(now);
    if (net.isHost && A.phase === 'playing') {
      tickBotsHost(now);
      const plist = Object.keys(A.players).map(id => {
        const p = A.players[id];
        return { id, x: p.x, y: p.y, alive: p.alive, invulnUntil: p.invulnUntil };
      });
      const hits = tickMonster(A.monster, A.grid, plist, Date.now());
      // ↑ 必须用 Date.now()：怪物要比对 p.invulnUntil，而那个值是 authority.damage()
      //   用 Date.now() 写进去的。传 rAF 的 now（页面启动毫秒）会让「现在 < 无敌到期」
      //   恒成立 —— 第一次被撞之后玩家就永久免疫，表现就是怪物贴着却再也咬不动。
      for (let i = 0; i < hits.length; i++) auth.damage(hits[i].userId, 'monster');
      if (now - lastSightTick >= SIGHT_TICK_MS) { lastSightTick = now; tickAbilitySight(); }
      if (now - lastPush >= PUSH_MS) { lastPush = now; publish(); }
      auth.checkEnd();
    }
  }
  if (phase === 'playing' && now - lastHud >= 100) {
    lastHud = now;
    renderHUD();
    renderButtons();
    // HUD 文字变长（能力名、房间号变成 6 位）可能让它从一行折成两行：
    // 预留高度一变就重算一次布局，否则侧栏让位不足会被 HUD 压住。
    // lastHudH 存的是「预留量」而不是原始高度，首次开局 HUD 正常出现时不会白跑一次 fit()。
    const reserve = hudReserve();
    if (lastHudH < 0) lastHudH = reserve;          // 首帧只记录，不白跑一次 fit()
    else if (reserve !== lastHudH) { lastHudH = reserve; fit(); }
  }
  renderFrame(now);
}

/* ---------------- 布局 ---------------- */
const MB_GAP = 8; // 必须与 escape.css 里 .stagewrap 的 row-gap 相等
const PAD_GAP = 8; // 与 .pad 的 gap 一致
const HUD_RESERVE_MIN = 38; // 一行 HUD(32) + 与侧栏的 6px 间隙
const EDGE_PAD = 2;        // 与迷宫一致的 1px 余量（左右各 1）

/** 虚拟键盘自适应：保持十字形状，按剩余高度缩放键帽，极矮屏按需上推内容 */
function sizePad() {
  const pad = ui.els.pad;
  const app = ui.els.app;
  // 先回到基准布局再量，避免上一次的上推量污染计算
  app.style.paddingBottom = '';
  if (!pad.classList.contains('show')) return;
  const sideRect = ui.els.side.getBoundingClientRect();
  const rowBottom = ui.els.actionRow.getBoundingClientRect().bottom;
  // 覆盖 .foot 占位区（侧栏底 -18px），但不得高于按钮行底 +4，避免挡住「呼出虚拟按钮」
  const padTop = Math.max(sideRect.bottom - 18, rowBottom + 4);
  pad.style.top = (padTop - sideRect.top) + 'px';
  const padRoom = window.innerHeight - padTop - 2;
  const baseKey = Math.floor(Math.max(52, Math.min(64, window.innerWidth * 0.14)));
  const key = Math.max(30, Math.min(baseKey, Math.floor((padRoom - PAD_GAP) / 2)));
  pad.style.setProperty('--key', key + 'px');
  // 键帽到下限仍放不下时，把内容整体上推（.wrap 可滚动兜底）
  const overflow = padTop + 2 * key + PAD_GAP - (window.innerHeight - 2);
  if (overflow > 0) app.style.paddingBottom = Math.ceil(overflow * 2 + 8) + 'px';
}

/** .wrap 的内边距。clientWidth/Height 含 padding，必须自己扣掉 ——
    否则手机上会算出一整屏宽的画面，把 12px 的左右留白吃掉、画面直接贴边。 */
function wrapPadding() {
  const cs = getComputedStyle(ui.els.wrap);
  return {
    x: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
    y: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  };
}

/** 只算、不落地：返回画面边长 */
function measureStage(landscape, reserve, prevS) {
  const wrap = ui.els.wrap, side = ui.els.side, mb = ui.els.musicbar, tb = ui.els.toolbar;
  const pd = wrapPadding();
  const mbH = mb.offsetHeight + MB_GAP;   // 恒 = 38 + 8 = 46
  // 工具条（房主的「返回房间」）恒占一行，禁用时也不收起来，画面尺寸才不会随身份/阶段跳。
  // CSS 里用 margin-bottom:-MB_GAP 吃掉了它和音乐条之间的 row-gap，所以净占高就是自身高度。
  const tbH = tb.offsetHeight;            // 恒 = 24
  let availW = Math.max(0, wrap.clientWidth - pd.x - EDGE_PAD);
  let availH = Math.max(0, wrap.clientHeight - pd.y - EDGE_PAD - mbH - tbH);
  if (landscape) {
    // 横屏侧栏宽度交回 CSS（min(34vw,260px)）。必须清掉竖屏写进去的 inline 宽度，
    // 否则 844×390 会按上一次竖屏的 600px 算侧栏，画面被挤到只剩 228px。
    side.style.width = '';
    availW -= side.offsetWidth + 16;      // 16 = body.landscape .app 的 gap
    // HUD 也在画面下方，两种朝向都给它留出这一行，否则矮横屏只能贴回画面内盖住地形
    availH -= reserve;
  } else {
    if (prevS > 0) side.style.width = prevS + 'px'; // 侧栏与画面同宽，先按上一轮宽度量高
    availH -= side.offsetHeight + reserve;
  }
  // 超大桌面给更大的画面；平板竖屏保持 600 上限，避免挤掉键盘/HUD 的竖向空间
  const wideScreen = window.innerWidth >= 1600 && window.innerHeight >= 1000;
  const cap = wideScreen ? 720 : 600;
  return Math.max(120, Math.min(availW, availH, cap));
}

function applyStageSize(s, landscape) {
  const mb = ui.els.musicbar;
  ui.els.stage.style.width = s + 'px';
  ui.els.stage.style.height = s + 'px';
  ui.els.stagewrap.style.width = s + 'px';
  ui.els.toolbar.style.width = s + 'px';
  mb.style.width = s + 'px';
  mb.classList.toggle('wide', s >= 420);
  mb.classList.toggle('compact', s < 320);
  mb.classList.toggle('tiny', s < 260);
  if (!landscape) ui.els.side.style.width = s + 'px';
}

/** HUD 悬在画面正下方（画面外）。窄屏折成两行后要占更多高度，
    把量到的高度写进 --hud-reserve，侧栏用 margin-top 让位。
    竖屏 fit() 扣的是 side.offsetHeight（不含 margin），所以画面尺寸不会被这条 margin 悄悄吃掉。 */
function hudReserve() {
  const hud = ui.els.hud;
  const h = hud.classList.contains('show') ? hud.offsetHeight : 0;
  return Math.max(HUD_RESERVE_MIN, h + 6);
}

function fit() {
  // 横屏判定用宽高比（与 maze.js 一致）：近正方形窗口堆叠更舒服，
  // 也避免 568×320 这类小横屏走进竖屏分支、画面被压到 120px。
  const landscape = window.innerWidth > window.innerHeight * 1.15;
  document.body.classList.toggle('landscape', landscape);
  // 画面宽 ↔ HUD 是否折行互相影响（画面越窄越容易折行），迭代到预留量稳定
  let reserve = hudReserve(), s = 0;
  for (let i = 0; i < 3; i++) {
    s = measureStage(landscape, reserve, s);
    applyStageSize(s, landscape);
    const want = hudReserve();
    if (Math.abs(want - reserve) < 1) break;
    reserve = want;
  }
  document.body.style.setProperty('--hud-reserve', reserve + 'px');
  renderer.resize(s);
  sizePad();
  const rect = ui.els.stagewrap.getBoundingClientRect();
  const hudH = ui.els.hud.classList.contains('show') ? ui.els.hud.offsetHeight : 0;
  const roomBelow = window.innerHeight - rect.bottom;
  ui.els.hud.classList.toggle('inside', hudH > 0 && roomBelow < hudH + 2);
}

/* ---------------- 联机事件绑定 ---------------- */
net.on('onGame', v => {
  viewGame = v;
  ensureGrid(v);
  if (pendingReveal && pendingReveal.roundId === v.roundId) handleReveal(pendingReveal);
  if (!joined) return;                    // 还没进房：只留快照，别把大厅顶回开场页
  syncPhase();
  if (phase === 'lobby') renderLobby();   // 房主改了人机名单要立刻重画座位
  if (net.isHost && v.phase === 'abilities') checkAbilitiesClosed();
});
net.on('onUsers', d => {
  profiles = d.profiles || {};
  // 真人进房挤掉人机，保证总座位不超过 4
  if (net.isHost && trimBots()) publish();
  resendReveals(d.users);
  if (phase === 'lobby') renderLobby();
  if (phase === 'abilities') renderAbility();
  if (net.isHost) checkAbilitiesClosed();
});
net.on('onEvent', evt => handleEvent(evt));
net.on('onReveal', d => handleReveal(d));
net.on('onInput', (d, ctx) => handleInput(d, ctx));
net.on('onHostLost', () => {
  net.leave();
  // 房主都没了，原房间号进不去人，连本地记录一起清
  resetSession('房主掉线，本局结束。可重新创建房间。');
});
// 房主侧信令全挂 → escape-net 自己换了另一套并重建了房间，这里只负责刷新展示
net.on('onFallback', info => {
  strategy = net.strategy;
  relayUrl = '';
  ui.setRelayUI(strategy, '');
  setStatus('原中继全部不可达，已自动切到 ' +
    (strategy === 'torrent' ? 'BitTorrent' : 'Nostr') +
    '（房间号 ' + info.shortCode + '）。把新房间号重新告诉大家，并确认他们那边的「中继」也一致。');
});
net.on('onStatus', err => {
  const code = err && err.code;
  if (code === 'relay-failed') lobbyStatus = '中继不可达：请切换 BitTorrent 策略或填写自定义 wss:// 中继';
  else if (code === 'relay-switch') lobbyStatus = '中继不可达，正在自动换成另一套信令重建房间…';
  else if (code === 'relay-switch-failed') lobbyStatus = '两套中继都不可达：换个网络，或手动换一种中继策略重试';
  else if (code === 'room-full') lobbyStatus = '房间已满（4 人）';
  else if (code === 'peer-connect-failed') {
    lobbyStatus = err.turnConfigured
      ? '点对点连不上（直连和公共 TURN 都没打通）：开手机热点对比一下，或点「网络自检」看卡在哪一步'
      : '点对点连不上：TURN 中转是关着的，双方都在严格 NAT 后面时必然失败，勾上「免费 TURN 中转」再试';
  }
  else if (code) lobbyStatus = '联机提示：' + code;
  if (phase === 'lobby') ui.setLobbyStatus(lobbyStatus);
});

/** ICE 自检结果 → 一句人话 + 该干什么 */
function describeProbe(r) {
  if (r.unsupported) return { text: '这个浏览器不支持 WebRTC，没法联机。', tone: 'warn' };
  if (!r.relay) {
    if (r.auth || r.unreach) {
      return { text: '公共 TURN 已失效（被拒或不可达），现在只能直连。', tone: 'warn' };
    }
    if (!r.srflx) {
      return { text: '只拿到内网地址（' + r.ms + 'ms）：这个网络把 UDP 挡住了，常见于校园网/公司网/浏览器 WebRTC 策略。换个热点再测一次。', tone: 'warn' };
    }
    return { text: '能直连，但拿不到中转：一方在对称 NAT 后面时才会失败。', tone: 'warn' };
  }
  return {
    text: '中转可用（' + r.relay + ' 条中继候选 / 共 ' + r.servers + ' 个服务器）：双方都在严格 NAT 后面也能连。',
    tone: 'ok'
  };
}

/* ---------------- UI 事件 ---------------- */
async function afterJoin() {
  joined = true;
  selfId = net.selfId;
  net.setProfile({ name: ui.getName(), color: ui.getColor(), closed: false, closedRound: 0, spectateTo: null });
  if (net.isHost) publish();   // 立刻把房主状态（含人机名单）写进共享状态，客端才知道谁是人机
  renderLobby();
  // 断线重进：join 期间 joined 还是 false，onGame 只更新快照、不切页面，
  // 这里补一次同步再统一走 syncPhase，才能直接落回进行中的对局而不是停在大厅
  const st = await net.requestSync();
  if (st && st.phase) { viewGame = st; ensureGrid(st); }
  if (joined) syncPhase();
  // 极端情况：换了浏览器/清过站点数据（或 ?identity=none），userId 变了就认不回座位
  if ((phase === 'playing' || phase === 'abilities') && !viewGame.players[selfId]) {
    ui.toast('这一局没有你的座位（浏览器身份变了）：等房主回大厅再开下一局');
  }
  saveRoom();
  ui.setResume('', '');
}

async function doCreate(resumeShort) {
  try {
    // 以界面当前选择为准：预设 / 自定义 / 默认都在 getRelayUI() 里归一化
    const r = ui.getRelayUI();
    strategy = r.strategy;
    relayUrl = r.url;
    setStatus(resumeShort ? '正在恢复房间…' : '正在创建房间…');
    const info = await net.createRoom(Object.assign({
      strategy, relayUrl, identityNone: q.identityNone, shortCode: resumeShort || ''
    }, iceOpts()));
    await afterJoin();
    setStatus(resumeShort
      ? '房间 ' + info.shortCode + ' 已恢复，本局已回到大厅。'
      : '房间 ' + info.shortCode + ' 已创建，把号码发给队友。');
  } catch (e) {
    setStatus('创建失败：' + ((e && e.message) || e));
  }
}

function strategyFromText(text) {
  try {
    const u = new URL(text, location.href);
    const s = u.searchParams.get('s');
    if (s === 'torrent' || s === 'nostr') return s;
  } catch (e) { /* 纯房间号 */ }
  return strategy;
}

/** 邀请链接里的 u= 是中继地址串：主机用哪几条，客人必须用同一批才能碰头 */
function relayFromText(text) {
  try {
    const u = new URL(text, location.href);
    return u.searchParams.get('u') || '';
  } catch (e) { return ''; }
}

/** 等房主出现。短码进房时没有 ~ 后缀可以抄房主的 peerId，只能等房间状态送过来，
    而公共中继的首次订阅 + 握手实测要 5 秒上下，所以窗口必须给足 ——
    太短会自己把房间销毁掉，表现就是「明明有人却提示房间没响应」。 */
async function waitHost(maxMs) {
  const t0 = performance.now();
  let shown = -1;
  while (performance.now() - t0 < maxMs) {
    if (net.isHost || net.hostUserId) return true;
    const sec = Math.floor((performance.now() - t0) / 1000);
    if (sec !== shown) { shown = sec; setStatus('正在连接房主… ' + sec + 's'); }
    await new Promise(r => setTimeout(r, 200));
  }
  return !!(net.isHost || net.hostUserId);
}

async function doJoin(text) {
  const id = normalizeRoomId(text);
  if (!id || id.indexOf('escape-') !== 0) {
    setStatus('请输入 6 位房间号（例如 123456）');
    return;
  }
  strategy = strategyFromText(text);
  const linkRelay = relayFromText(text) || q.relay;
  if (linkRelay) relayUrl = linkRelay;
  ui.setRelayUI(strategy, relayUrl);
  try {
    setStatus('正在加入房间…');
    await net.join(id, Object.assign({
      strategy, relayUrl, identityNone: q.identityNone
    }, iceOpts()));
    await afterJoin();
    // afterJoin 里的 requestSync 已经给过 2.5 秒；再留一点余量。
    // 仍然认不出房主 = 房间号错了 / 房里没人 / 双方不在同一条中继上。
    if (!(await waitHost(12000))) {
      await net.leave();
      joined = false;
      setStatus('房间 ' + (id.replace('escape-', '')) + ' 没有响应。检查房间号是否输错；'
        + '若房主改过「中继」，两边要选同一条（默认都是 Nostr）。');
      setPhase('lobby');
      renderLobby();
      return;
    }
    setStatus(phase === 'playing' ? '已回到进行中的对局。'
      : phase === 'abilities' ? '已回到对局（正在选能力）。'
      : phase === 'review' ? '本局已结束，正在看结算。'
      : '已加入房间，等待房主开始。');
  } catch (e) {
    setStatus('加入失败：' + ((e && e.message) || e));
  }
}

/** 断线续玩：读本地记录，客端按原 roomId 重进（拿回同一个座位），
    房主复用短码重建同一间房（本局状态已随刷新丢失，全队回大厅）。 */
async function resumeRoom() {
  const saved = loadRoom();
  if (!saved) { ui.setResume('', ''); return; }
  if (saved.relay) relayUrl = saved.relay;
  if (saved.strategy) strategy = saved.strategy;
  ui.setRelayUI(strategy, relayUrl);
  setPhase('lobby');
  if (saved.host) {
    await doCreate(saved.short || '');
    // 只有 userId 真变了（换浏览器 / 清过站点数据）房间号才会不同，老链接就废了
    if (saved.room && net.fullRoomId !== saved.room) {
      ui.toast('房间号变了（浏览器身份丢了），请把新房间号重新告诉大家');
    }
    return;
  }
  await doJoin(saved.room);
}

/** 回到房间：房主把权威状态拉回大厅并广播出去，客端收到 game.phase='lobby'
    就一起回大厅（syncPhase），所以「房主回房间 = 全队回房间」是同一个开关。 */
function backToRoom() {
  net.setProfile({ closed: false, closedRound: 0, spectateTo: null });
  if (net.isHost) {
    A.phase = 'lobby';
    A.review = null;
    setStatus('回到房间，等待房主再次开始。');
    publish();
    setPhase('lobby');
  } else {
    setStatus('等待房主回到房间…');
  }
}

ui.bind({
  onStart: () => { setPhase('lobby'); if (q.room) doJoin(q.room); },
  onCreate: doCreate,
  onJoin: doJoin,
  onCopyInvite: () => {
    // 只复制 6 位房间号：客人在「加入房间」里输这 6 位就能进，不需要长链接。
    // 链接里那些 s= / u= 是信令策略与中继，短码路径下两边都用默认值即可。
    const code = net.shortCode || '';
    if (!code) { setStatus('还没创建房间，没有房间号可复制。'); return; }
    const put = () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code)
          .then(() => ui.toast('房间号 ' + code + ' 已复制'))
          .catch(() => setStatus('请手动记下房间号：' + code));
      } else {
        setStatus('请手动记下房间号：' + code);
      }
    };
    put();
  },
  onLeave: async () => {
    await net.leave();
    resetSession('已离开房间。');
  },
  onResume: resumeRoom,
  onAddBot: addBot,
  onRemoveBot: removeBot,
  onStartGame: auth.startGame,
  // 网络自检：本地收集一次 ICE 候选，判断这台机器能不能穿过当前网络
  onNetCheck: async () => {
    if (netCheckBusy) return;
    netCheckBusy = true;
    ui.setNetNote('正在探测 ICE 候选（最多 6 秒）…');
    try {
      const d = describeProbe(await net.probeIce(iceOpts()));
      ui.setNetNote(d.text, d.tone);
    } catch (e) {
      ui.setNetNote('自检失败：' + ((e && e.message) || e), 'warn');
    }
    netCheckBusy = false;
  },
  onAbilityClose: () => net.setProfile({ closed: true, closedRound: viewGame.roundId }),
  onBackToRoom: backToRoom,
  // 房主的「返回房间」在音乐条右上方，错点一下就把全队这局废了，所以要两段式确认
  onBackRoomTop: () => {
    if (!net.isHost || (phase !== 'playing' && phase !== 'abilities')) return;
    const now = performance.now();
    if (now > backArmUntil) {
      backArmUntil = now + 3000;
      ui.toast('再点一次「返回房间」——本局立刻结束，全队回大厅');
      return;
    }
    backArmUntil = 0;
    backToRoom();
  },
  onWall: () => {
    const me = viewGame.players[selfId];
    if (phase !== 'playing' || myAbility() !== 4 || !me || !me.alive || me.wallCharges <= 0) return;
    pendingWall = true;
    ui.toast('下一次移动将穿透一格墙');
  },
  onRevive: () => {
    const me = viewGame.players[selfId];
    if (!me || !me.alive) return;
    const ids = Object.keys(viewGame.players);
    for (let i = 0; i < ids.length; i++) {
      const p = viewGame.players[ids[i]];
      if (!p.alive && !p.reviveUsed && p.x === me.x && p.y === me.y) {
        net.sendInput({ roundId: viewGame.roundId, seq: ++inputSeq, action: 'revive', target: ids[i] });
        return;
      }
    }
  },
  onSpec: step => {
    const ids = Object.keys(viewGame.players).filter(id => viewGame.players[id].alive && id !== selfId);
    if (!ids.length) return;
    const cur = ownProfile().spectateTo;
    let i = ids.indexOf(cur);
    i = (i + step + ids.length) % ids.length;
    net.setProfile({ spectateTo: ids[i] });
  },
  onRelayChange: (s, url) => { strategy = s; relayUrl = url; },
  onColor: c => { if (joined) net.setProfile({ color: c }); },
  onName: n => { if (joined) net.setProfile({ name: n }); }
});

// 键盘展开/收起后只重算键帽与上推量，不跑 fit()，画面尺寸保持不变
ui.els.btnKb.addEventListener('click', () => requestAnimationFrame(sizePad));

/* ---------------- 输入设备 ---------------- */
/* 按钮点击音走事件委托：按钮会随阶段动态显隐，逐个挂监听迟早漏掉一个。
   音效徽标自己开关时已经响过，这里跳过，避免一按两响。 */
document.addEventListener('click', e => {
  const t = e.target;
  if (!t || !t.closest || t.closest('#mbSfx')) return;
  if (t.closest('.btn, .mb-btn, .mb-badge, .swatch, .picker')) sfx.play('click');
}, false);

function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
/** 真键盘：与虚拟键盘共用同一套 holdDir/holdAt 状态机，节奏必须是 STEP_MS 一格。 */
window.addEventListener('keydown', e => {
  if (isTyping(e.target)) return;
  const d = KEYMAP[e.key];
  if (!d) return;
  e.preventDefault();
  // 系统按键重复一律丢弃（和迷宫同一个理由，但这里的后果更严重）：
  // 浏览器按住方向键约 30 次/秒重复派发 keydown，每次都会把 holdAt 重置成
  // 「现在 - STEP_MS」，tickInput 于是每帧都放行、房主侧 tryMove 又不节流 ——
  // 按住半秒后会从 6 格/秒变成 60 格/秒。虚拟键盘只有一次 pointerdown，
  // 丢掉 repeat 之后两边都严格是 STEP_MS 一格。
  if (e.repeat) return;
  if (pressedKeys.indexOf(e.key) < 0) pressedKeys.push(e.key);
  holdDir = d;
  holdAt = performance.now() - STEP_MS;
});

/** 松手：清掉按住方向，同时允许下一次撞墙重新出声
    （长按顶墙只响一次，松手再按又是一下） */
function releaseHold() { holdDir = null; bumpDir = null; pressedKeys.length = 0; }

window.addEventListener('keyup', e => {
  if (!KEYMAP[e.key]) return;
  const i = pressedKeys.indexOf(e.key);
  if (i < 0) return;
  pressedKeys.splice(i, 1);
  // 松开的正是「当前生效」的那个方向（即最后按下的）：还按着别的方向键就平滑接上，
  // 一个都不剩才真的停住。否则斜着走换向时一松手就顿在原地。
  if (i === pressedKeys.length) {
    const next = pressedKeys[pressedKeys.length - 1];
    if (next) {
      holdDir = KEYMAP[next];
      holdAt = performance.now() - STEP_MS;
    } else {
      releaseHold();
    }
  }
});
window.addEventListener('blur', releaseHold);
ui.els.pad.querySelectorAll('button').forEach(b => {
  b.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const d = DIR_BY_NAME[b.getAttribute('data-dir')];
    if (!d) return;
    holdDir = d;
    holdAt = performance.now() - STEP_MS;
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => b.addEventListener(t, releaseHold));
  b.addEventListener('contextmenu', ev => ev.preventDefault());
});
window.addEventListener('pointerup', releaseHold);

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);

/* ---------------- 调试接口 ---------------- */
window.EscapeDebug = {
  get phase() { return phase; },
  get grid() { return grid; },
  get lit() { return lastSight ? lastSight.lit : null; },
  get sight() { return lastSight; },
  get players() { return viewGame.players; },
  get monster() { return viewGame.monster; },
  get mapHash() { return viewGame.mapHash; },
  get abilities() { return viewGame.abilities; },
  get game() { return viewGame; },
  get authority() { return A; },
  get selfId() { return selfId; },
  get profiles() { return profiles; },
  get net() { return net; },
  get sfx() { return sfx; },
  get bots() { return botList().map(b => ({ id: b.id, name: b.name, color: b.color })); },
  get botAgents() { return botAgents; },
  start: auth.startGame,
  addBot, removeBot,
  move: dir => net.sendInput({ roundId: viewGame.roundId, seq: ++inputSeq, dir, wall: false, action: 'move' }),
  setHp: (id, hp) => { if (A.players[id]) { A.players[id].hp = hp; publish(); } },
  end: win => auth.endGame(win)
};

/* ---------------- 启动 ---------------- */
ui.setRelayUI(strategy, relayUrl);
fit();
setTimeout(fit, 60);
if (q.room) {
  setPhase('lobby');
  doJoin(q.room);
} else {
  // 手动用房间号加入过的人，刷新后靠这条找回；邀请链接进的人 URL 里带着 room，会直接重进
  const saved = q.solo ? null : loadRoom();
  if (saved) ui.setResume(saved.room, saved.short);
  setPhase('intro');
}
requestAnimationFrame(loop);
