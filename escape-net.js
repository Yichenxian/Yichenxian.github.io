/* ============================================================
   合作逃生 · trystero 0.27 联机封装（纯静态，无后端、无构建）
   房主 roles({selfAsAdmin:true}) → makeState 默认 admin-only 写入
   客端 roles() + 完整带 ~ 的 roomId
   ============================================================ */

export const APP_ID = 'harness-escape/2026';
const VER = 'v=20261113l';

export const GAME0 = {
  phase: 'lobby', roundId: 0, hostUserId: '',
  size: 51, mapB64: '', mapHash: '',
  keys: [], realTotal: 0, fakeTotal: 0, realTaken: 0, fakePicked: 0, taken: {},
  exitI: -1, exitActive: false, monsterHomeI: -1, spawns: [],
  abilities: {}, allyUnlocked: false,
  players: {}, bots: [],
  monster: { x: 0, y: 0, st: 'wander', target: null },
  startedAt: 0, keysDoneAt: 0, endedAt: 0, win: false,
  stats: { dmgFake: 0, dmgMonster: 0, reviveCount: 0 },
  review: null
};

export function parseQuery() {
  const q = new URLSearchParams(location.search);
  const turn = q.get('turn');
  return {
    room: q.get('room') || '',
    strategy: q.get('s') || 'nostr',
    relay: q.get('u') || '',
    identityNone: q.get('identity') === 'none',
    solo: q.get('solo') === '1',
    // turn=0/off 关掉 TURN；turn=turn:a:3478,turns:b:5349 换自己的服务器
    turnOff: turn === '0' || turn === 'off',
    turnUrls: turn && turn !== '0' && turn !== 'off'
      ? turn.split(',').map(s => s.trim()).filter(Boolean) : [],
    turnUser: q.get('turnuser') || '',
    turnPass: q.get('turnpass') || ''
  };
}

/* ---------------- 免费 ICE：STUN 发现 + TURN 兜底 ----------------
   两者都是无需账号的公共服务，不产生任何费用。TURN 只在直连打不通时
   才被 ICE 选中（浏览器优先 host/srflx 候选），所以开着它不会拖慢正常
   玩家，只在对称 NAT / 校园网 / 公司网下救命。
   换自己的服务：?turn=turn:h:3478,turns:h:5349&turnuser=u&turnpass=p
   只留 STUN：?turn=0
   公共 TURN 可能随时失效 —— 大厅「网络自检」会报告它到底通不通。 */
const STUN_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478'
];

const TURN_URLS = [
  'turn:openrelay.metered.ca:80',
  'turn:openrelay.metered.ca:443',
  'turn:openrelay.metered.ca:443?transport=tcp',
  'turns:openrelay.metered.ca:443?transport=tcp'
];

const TURN_USER = 'openrelayproject';
const TURN_PASS = 'openrelayproject';

/** 把各种来源（query / 大厅开关）归一成一份 ICE 配置 */
function normalizeIce(opts) {
  const o = opts || {};
  const urls = (o.turnUrls && o.turnUrls.length) ? o.turnUrls : TURN_URLS;
  return {
    turn: o.turn !== false,
    turnUrls: urls,
    turnUser: o.turnUser || TURN_USER,
    turnPass: o.turnPass || TURN_PASS
  };
}

/** ICE 服务器清单的唯一出处：真正建连（baseConfig）和网络自检（probeIce）都读它。
 *  分成两处各写一遍的话，改了 STUN/TURN 列表却漏改另一边，自检就会开始说谎。 */
function iceServerList(ice) {
  const list = STUN_URLS.map(u => ({ urls: u }));
  if (ice.turn) {
    for (let i = 0; i < ice.turnUrls.length; i++) {
      list.push({ urls: ice.turnUrls[i], username: ice.turnUser, credential: ice.turnPass });
    }
  }
  return list;
}
const IS_TURN = /^turns?:/i;

/** 一次 ICE 收集，用来判断"这台机器能不能穿过当前网络"。
 *  relay > 0 → TURN 可用，严格 NAT 也能连；srflx = 0 → UDP 八成被封。 */
function probeIce(opts, timeoutMs) {
  const servers = iceServerList(normalizeIce(opts));
  const out = { host: 0, srflx: 0, relay: 0, auth: 0, unreach: 0, servers: servers.length, ms: 0, unsupported: false };
  const Ctor = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Ctor) { out.unsupported = true; return Promise.resolve(out); }

  return new Promise(resolve => {
    const started = Date.now();
    let pc = null, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      out.ms = Date.now() - started;
      try { if (pc) pc.close(); } catch (e) { /* 已关闭 */ }
      resolve(out);
    };
    try { pc = new Ctor({ iceServers: servers }); } catch (e) { return finish(); }
    pc.onicecandidate = e => {
      const c = e.candidate;
      if (!c) return finish();                    // null = 收集结束
      const t = c.type;
      if (t === 'host' || t === 'srflx' || t === 'relay') out[t]++;
    };
    // 401/403 = TURN 要账号；701 = 服务器不可达。两者都说明这条 TURN 白配了
    pc.onicecandidateerror = e => {
      if (!e || !e.errorCode) return;
      if (e.errorCode === 401 || e.errorCode === 403) out.auth++;
      else out.unreach++;
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(finish);
    } catch (e) { finish(); }
    setTimeout(finish, timeoutMs || 6000);
  });
}

/** 支持粘贴完整房间号，也支持直接粘贴邀请链接 */
export function extractRoomId(text) {
  if (!text) return '';
  const t = text.trim();
  try {
    const u = new URL(t, location.href);
    const r = u.searchParams.get('room');
    if (r) return r;
    const s = u.searchParams.get('s');
    if (s) return '';
  } catch (e) { /* 不是 URL，按原始房间号处理 */ }
  const m = t.match(/[?&]room=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return t;
}

/** 邀请链接拼接：u= 带上房主用的中继地址，双方必须连同一批中继才能碰头 */
export function buildInviteUrl(base, roomId, strategy, relayUrl) {
  return base + '?room=' + encodeURIComponent(roomId) +
    '&s=' + encodeURIComponent(strategy) +
    (relayUrl ? '&u=' + encodeURIComponent(relayUrl) : '');
}

function sixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function loadStrategy(strategy) {
  const file = strategy === 'torrent' ? 'trystero-torrent.mjs' : 'trystero.mjs';
  return await import('./vendor/' + file + '?' + VER);
}

export function createNet() {
  let mod = null, room = null;
  let profile = null, game = null;
  let actInput = null, actEvt = null, actReveal = null, actSync = null;
  let selfId = '', fullRoomId = '', shortCode = '', strategy = 'nostr', relayUrl = '';
  let isHost = false, hostUserId = '', identityNone = false;
  let lastOpts = null, fallbackDone = false;

  const listeners = {
    onGame: [], onEvent: [], onReveal: [], onInput: [],
    onUsers: [], onStatus: [], onHostLost: [], onFallback: []
  };

  function on(name, fn) { if (listeners[name]) listeners[name].push(fn); }
  function emit(name, ...args) {
    const list = listeners[name] || [];
    for (let i = 0; i < list.length; i++) {
      try { list[i].apply(null, args); } catch (e) { console.error('[escape-net] ' + name, e); }
    }
  }

  function baseConfig(ice) {
    // rtcConfig.iceServers 会顶掉 trystero 内置列表，所以 STUN 必须自己列全；
    // turnConfig 是"追加"，两段合起来才是最终 iceServers —— 这里按同一份清单切两半
    const list = iceServerList(normalizeIce(ice));
    const cfg = {
      appId: APP_ID,
      maxUsers: 4,
      identity: identityNone ? 'none' : 'local',
      relayConfig: { warnOnRelayFailure: false },
      rtcConfig: { iceServers: list.filter(s => !IS_TURN.test(s.urls)) }
    };
    const turn = list.filter(s => IS_TURN.test(s.urls));
    if (turn.length) cfg.turnConfig = turn;
    if (relayUrl) {
      cfg.relayConfig.urls = relayUrl.split(',').map(s => s.trim()).filter(Boolean);
    }
    return cfg;
  }

  function emitUsers() {
    if (!room) return;
    const users = room.getUsers() || {};
    emit('onUsers', {
      count: 1 + Object.keys(users).length,
      users,
      profiles: profile ? profile.getAll() : {}
    });
  }

  function setupChannels() {
    profile = room.makeUserState('profile', { color: '#ffffff', closed: false, closedRound: 0, spectateTo: null });
    game = room.makeState('game', GAME0, { maxBytes: 65536 });
    actInput = room.makeAction('input');
    actEvt = room.makeAction('evt', { roles: ['admin'] });
    actReveal = room.makeAction('reveal', { roles: ['admin'] });
    actSync = room.makeAction('sync', { kind: 'request' });

    game.onChange((v, ctx) => emit('onGame', v, ctx), { replay: true });
    actEvt.onMessage((d, ctx) => {
      if (ctx && ctx.userId === hostUserId) emit('onEvent', d, ctx);
    });
    actReveal.onMessage((d, ctx) => {
      if (ctx && ctx.userId === hostUserId) emit('onReveal', d, ctx);
    });
    actInput.onMessage((d, ctx) => {
      if (isHost) emit('onInput', d, ctx);
    });
    actSync.onRequest(() => game.get());
    profile.onChange(() => emitUsers(), { replay: true });

    room.onUserJoin(() => emitUsers(), { replay: true });
    room.onUserLeave((c) => {
      emitUsers();
      if (!isHost && c && c.userId === hostUserId) emit('onHostLost');
    });
    room.onError(err => {
      emit('onStatus', err);
      maybeRelayFallback(err);
    });
    emitUsers();
  }

  /** 归一化入口参数：strategy / 中继串 / TURN 开关，一次算清，重连时复用 */
  function takeOpts(opts) {
    const o = opts || {};
    const ice = normalizeIce(o);
    return {
      strategy: o.strategy || strategy,
      relayUrl: o.relayUrl || '',
      identityNone: !!o.identityNone,
      turn: ice.turn, turnUrls: ice.turnUrls,
      turnUser: ice.turnUser, turnPass: ice.turnPass,
      // 房主刷新后恢复自己的房间：短码复用 → 因 userId 存在 IndexedDB 里不变，
      // 重建出来的 roomId 与刷新前完全一致，邀请链接不用重发
      shortCode: o.shortCode || ''
    };
  }

  async function createRoom(opts) {
    lastOpts = takeOpts(opts);
    fallbackDone = false;
    return await openHost(lastOpts);
  }

  async function openHost(o) {
    strategy = o.strategy;
    relayUrl = o.relayUrl;
    identityNone = o.identityNone;
    mod = await loadStrategy(strategy);
    // 自动换信令时保留同一个短码；房主刷新恢复时用传进来的短码
    if (!shortCode) shortCode = o.shortCode || sixDigit();
    const cfg = baseConfig(o);
    cfg.use = [mod.roles({ selfAsAdmin: true })];
    room = mod.joinRoom(cfg, 'escape-' + shortCode);
    const self = await room.getSelf();
    selfId = self.userId;
    fullRoomId = self.roomId;
    hostUserId = self.userId;
    isHost = true;
    setupChannels();
    return { roomId: fullRoomId, shortCode };
  }

  async function join(fullId, opts) {
    lastOpts = takeOpts(opts);
    // 客端不自动换信令：换到房主不在的那条中继上，只会连到一个空房间
    fallbackDone = true;
    return await openGuest(fullId, lastOpts);
  }

  async function openGuest(fullId, o) {
    strategy = o.strategy;
    relayUrl = o.relayUrl;
    identityNone = o.identityNone;
    mod = await loadStrategy(strategy);
    const cfg = baseConfig(o);
    cfg.use = [mod.roles()];
    room = mod.joinRoom(cfg, fullId);
    const self = await room.getSelf();
    selfId = self.userId;
    fullRoomId = self.roomId || fullId;
    hostUserId = fullId.indexOf('~') >= 0 ? fullId.split('~')[1] : '';
    isHost = false;
    shortCode = (fullId.split('~')[0].replace('escape-', '') || '').slice(0, 6);
    setupChannels();
    return { roomId: fullRoomId, shortCode };
  }

  /** 房主专用：整套信令全挂时，自动换另一套（Nostr ↔ BitTorrent）重建房间。
   *  只在还没人进房时动手 —— 有人连上了就绝不换房间号。换完用 onFallback
   *  通知 UI 重新展示房间号/邀请链接，队友要拿新链接。 */
  function maybeRelayFallback(err) {
    if (!isHost || fallbackDone || !room) return;
    if (err && err.code !== 'relay-failed') return;
    if (Object.keys(room.getUsers() || {}).length) return;
    fallbackDone = true;
    const next = strategy === 'torrent' ? 'nostr' : 'torrent';
    // 自定义 wss 串很可能就是打不通的那一个，回退时一律丢掉，改用内置池
    const o = Object.assign({}, lastOpts, { strategy: next, relayUrl: '' });
    const keepCode = shortCode;
    emit('onStatus', { code: 'relay-switch', strategy: next });
    leave().then(() => {
      shortCode = keepCode;
      return openHost(o);
    }).then(r => {
      lastOpts = o;
      emit('onFallback', r);
      emitUsers();
    }).catch(e => emit('onStatus', { code: 'relay-switch-failed', cause: e }));
  }

  function setProfile(patch) {
    if (!profile) return;
    profile.set(prev => Object.assign({}, prev, patch));
  }

  function setGame(patch) {
    if (!game || !isHost) return;
    try {
      const p = game.set(prev => Object.assign({}, prev, patch));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { console.error('[escape-net] setGame', e); }
  }

  function sendInput(payload) {
    if (!actInput) return;
    if (isHost) { emit('onInput', payload, { userId: selfId }); return; }
    actInput.send(payload, { target: hostUserId });
  }

  function sendEvent(evt) { if (actEvt && isHost) actEvt.send(evt); }
  function sendReveal(target, data) { if (actReveal && isHost) actReveal.send(data, { target }); }

  async function requestSync() {
    if (!actSync || isHost || !hostUserId) return null;
    try { return await actSync.request(null, { target: hostUserId, timeoutMs: 2500 }); }
    catch (e) { return null; }
  }

  function inviteUrl() {
    // 用当前页面的 origin + pathname 拼：部署到 GitHub Pages 就是
    // https://<用户名>.github.io/<仓库>/escape.html —— 不写死任何域名。
    // 唯一例外是 file://：它的 location.origin 是字符串 "null"，拼出来必然是坏链接。
    if (location.protocol === 'file:') return '';
    // u= 带上房主用的中继地址：双方必须连同一批中继才能碰头
    return buildInviteUrl(location.origin + location.pathname, fullRoomId, strategy, relayUrl);
  }

  async function leave() {
    if (room) { try { await room.leave(); } catch (e) {} }
    room = null; profile = null; game = null;
    actInput = null; actEvt = null; actReveal = null; actSync = null;
    isHost = false; fullRoomId = ''; shortCode = '';
    // 大厅是按 getUsers() 画座位的：离开后必须再广播一次空名册，
    // 否则会一直挂着上一个房间的队友（emitUsers 在 room=null 时会早退，所以这里直接 emit）
    emit('onUsers', { count: 1, users: {}, profiles: {} });
  }

  return {
    on, createRoom, join, setProfile, setGame, sendInput, sendEvent, sendReveal,
    requestSync, inviteUrl, leave, emitUsers,
    probeIce: (o) => probeIce(Object.assign({}, lastOpts || {}, o)),
    getProfiles: () => profile ? profile.getAll() : {},
    getGame: () => game ? game.get() : GAME0,
    getUsers: () => room ? (room.getUsers() || {}) : {},
    get selfId() { return selfId; },
    get isHost() { return isHost; },
    get hostUserId() { return hostUserId; },
    get fullRoomId() { return fullRoomId; },
    get shortCode() { return shortCode; },
    get strategy() { return strategy; },
    get room() { return room; }
  };
}

/** 单机调试：跳过 WebRTC，本地跑完整房主逻辑；空座位用「添加人机」补位 */
export function createSoloNet() {
  const profiles = {
    solo0: { color: '#ffffff', closed: false, closedRound: 0, spectateTo: null }
  };
  const users = {};
  const listeners = { onGame: [], onEvent: [], onReveal: [], onInput: [], onUsers: [], onStatus: [], onHostLost: [], onFallback: [] };
  const on = (name, fn) => { if (listeners[name]) listeners[name].push(fn); };
  const emit = (name, ...args) => {
    const list = listeners[name] || [];
    for (let i = 0; i < list.length; i++) {
      try { list[i].apply(null, args); } catch (e) { console.error('[solo-net] ' + name, e); }
    }
  };
  let game = Object.assign({}, GAME0);
  const emitUsers = () => emit('onUsers', { count: 1 + Object.keys(users).length, users, profiles });
  // 和真房主一样：点「创建房间」之前还不算有房间（中继下拉才可改）
  const ROOM_ID = 'escape-000000~solo0';
  let created = false;
  const makeRoom = async () => { created = true; return { roomId: ROOM_ID, shortCode: '000000' }; };
  return {
    on,
    createRoom: makeRoom,
    join: makeRoom,
    setProfile(patch) {
      profiles.solo0 = Object.assign({}, profiles.solo0, patch);
      emitUsers();
    },
    setGame(patch) { game = Object.assign({}, game, patch); emit('onGame', game, { userId: 'solo0' }); },
    sendInput(payload) { emit('onInput', payload, { userId: 'solo0' }); },
    sendEvent(evt) { emit('onEvent', evt, { userId: 'solo0' }); },
    sendReveal(target, data) { emit('onReveal', data, { userId: 'solo0' }); },
    requestSync: async () => game,
    inviteUrl: () => location.href,
    leave: async () => {},
    emitUsers,
    // 单机也能自检网络：本机 UDP / TURN 通不通跟联不联机无关
    probeIce: (o) => probeIce(o),
    getProfiles: () => profiles,
    getGame: () => game,
    getUsers: () => users,
    get selfId() { return 'solo0'; },
    get isHost() { return true; },
    get hostUserId() { return 'solo0'; },
    get fullRoomId() { return created ? ROOM_ID : ''; },
    get shortCode() { return created ? '000000' : ''; },
    get strategy() { return 'solo'; },
    get room() { return null; }
  };
}
