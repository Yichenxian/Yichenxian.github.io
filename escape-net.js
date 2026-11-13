/* ============================================================
   合作逃生 · trystero 0.27 联机封装（纯静态，无后端、无构建）
   入房只需 6 位房间号：房主 joinRoom('escape-'+短码)，客端同样，
   房主的 peerId 从房间状态（publicGame.hostUserId）里认，不靠链接后缀。
   注意：cfg.use 里不要装 roles —— 实测会让两端互相看不见（见 setupChannels 注释）。
   ============================================================ */

export const APP_ID = 'harness-escape-2026';

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
/** 默认信令中继 —— **两端必须完全一致**才能碰头。
    trystero 的内置池是 30 条里随机取 5 条，房主和访客各随机一次，大概率错开；
    这正是以前必须把 u= 塞进邀请链接里的原因。改成「只报 6 位房间号」以后，
    没有任何地方能传这串地址，所以默认值必须固定（2026-11-13 实测可连、允许匿名写入）。
    想让两端换一批：大厅「中继」里选同一组，或填同一串自定义 wss。
    BitTorrent 策略走内置 tracker，本来就是固定的，不受这里影响。 */
const DEFAULT_RELAYS = [
  'wss://nostr.azzamo.net',
  'wss://nostr.data.haus',
  'wss://nostr.chaima.info',
  'wss://nostr.hifish.org',
  'wss://nostr.sathoarder.com'
];

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

/** 把用户输入的任意形式归一成 trystero 的房间名：
    123456 / escape-123456 / escape-123456~peerId / 邀请链接 都能认。
    只报 6 位短码时补上 escape- 前缀 —— 房主建房用的就是 'escape-' + 短码，
    所以短码本身就足以入房，不需要链接里的 ~ 后缀（房主的 peerId 会从房间状态里认）。 */
export function normalizeRoomId(text) {
  const raw = extractRoomId(text);
  if (!raw) return '';
  const t = String(raw).trim();
  if (/^\d{4,8}$/.test(t)) return 'escape-' + t;
  return t;
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
  // 不能带 ?v= 查询串：带与不带在浏览器里是两个模块实例，而 trystero 用
  // Symbol.for('trystero.slot') 这类**全局**槽位管房间，两份实例会各自记账。
  return await import('./vendor/' + file);
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
    } else if (strategy !== 'torrent') {
      // 不给就固定这一组，别落回 trystero 的「随机 5/30」—— 那会让两端错开
      cfg.relayConfig.urls = DEFAULT_RELAYS;
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
    profile = room.makeUserState('profile', { name: '', color: '#ffffff', closed: false, closedRound: 0, spectateTo: null });
    game = room.makeState('game', GAME0, { maxBytes: 65536 });
    actInput = room.makeAction('input');
    actEvt = room.makeAction('evt');
    actReveal = room.makeAction('reveal');
    actSync = room.makeAction('sync', { kind: 'request' });

    game.onChange((v, ctx) => {
      // 客人靠这一句认出房主。publicGame 里本来就带 hostUserId，所以「只报 6 位短码」
      // 也能进房 —— 不必让客人从邀请链接的 ~ 后缀里抄房主的 22 位 peerId。
      // 认出之前 hostUserId 为空，输入走广播、evt 不过滤，认得之后自动切成定向。
      if (!isHost && v && v.hostUserId && v.hostUserId !== hostUserId) {
        hostUserId = v.hostUserId;
        emitUsers();
      }
      emit('onGame', v, ctx);
    }, { replay: true });
    actEvt.onMessage((d, ctx) => {
      if (!hostUserId || (ctx && ctx.userId === hostUserId)) emit('onEvent', d, ctx);
    });
    actReveal.onMessage((d, ctx) => {
      if (!hostUserId || (ctx && ctx.userId === hostUserId)) emit('onReveal', d, ctx);
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
    // 故意不装 roles 中间件：实测 vendor 里这份 trystero 只要 cfg.use 带了 roles，
    // 房主与客端就永远看不到彼此（同一个 roomId 下 onPeerJoin 一次都不触发，
    // 对照实验里去掉 use 立刻互通）。而 roles 原本只用来限制「谁能写 game / 谁能发 evt」，
    // 这两件事现在都由接收端按 hostUserId 过滤 + setGame 里 isHost 早退兜住了，不需要它。
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

    room = mod.joinRoom(cfg, fullId);
    const self = await room.getSelf();
    selfId = self.userId;
    fullRoomId = self.roomId || fullId;
    // 完整房间号里带着房主 peerId 就先记下；只给了 6 位短码时这里是空的，
    // 等 game 状态到达后由 setupChannels 里的 onChange 补上（不依赖邀请链接）。
    hostUserId = fullId.indexOf('~') >= 0 ? fullId.split('~')[1] : '';
    isHost = false;
    shortCode = (fullId.split('~')[0].replace('escape-', '') || '').slice(0, 6);
    setupChannels();
    return { roomId: fullRoomId, shortCode };
  }

  /** 房主专用：整套信令全挂时，自动换另一套（Nostr ↔ BitTorrent）重建房间。
   *  只在还没人进房时动手 —— 有人连上了就绝不换房间号。换完用 onFallback
   *  通知 UI 重新展示房间号，队友要用同一个房间号加入。 */
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
    // 还没认出房主（刚用短码进房、房间状态还没到）就先广播：房主侧只认 isHost，
    // 其他客人会直接忽略，多花一点带宽换「按键不丢」。
    if (hostUserId) actInput.send(payload, { target: hostUserId });
    else actInput.send(payload);
  }

  function sendEvent(evt) { if (actEvt && isHost) actEvt.send(evt); }
  function sendReveal(target, data) { if (actReveal && isHost) actReveal.send(data, { target }); }

  async function requestSync() {
    if (!actSync || isHost) return null;
    try {
      // 认出房主就定向问；还没认出就广播 —— 房主的 sync 通道会响应，返回值里带 hostUserId
      const opts = { timeoutMs: 2500 };
      if (hostUserId) opts.target = hostUserId;
      return await actSync.request(null, opts);
    } catch (e) { return null; }
  }

  /** 生成带 ?room=&s=&u= 的完整链接。UI 已经改成只分享 6 位房间号，
      这里保留给「旧链接 / 手动拼深链」的兼容场景（extractRoomId 仍能解析它）。 */
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
    // hostUserId 必须一起清：它现在会在进房途中从 game 状态回填，
    // 留着旧值会让下一次进房的输入先定向发给上一位房主。
    hostUserId = '';
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
    solo0: { name: '', color: '#ffffff', closed: false, closedRound: 0, spectateTo: null }
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
    // 离开必须把 created 清掉：fullRoomId / shortCode 都靠它，否则 solo 下「离开房间」
    // 等于没反应（房间号还挂着），大厅里那排按钮也不会回到「创建 / 加入」状态。
    leave: async () => { created = false; },
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
