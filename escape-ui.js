/* ============================================================
   合作逃生 · 界面层（DOM 全在画面外，遮罩只有三个）
   ============================================================ */

export const PALETTE = [
  '#ffffff', '#ff4d4d', '#ffd93d', '#4dff88', '#4dd2ff',
  '#b066ff', '#ff6ec7', '#ff9f43', '#00d2d3', '#111111'
];

export const ABILITY_INFO = {
  1: { name: '透视钥匙', desc: '能看到所有钥匙在迷宫中的位置（含迷雾之外）。假钥匙混在其中，靠队友沟通分辨。' },
  2: { name: '辨别真假', desc: '你看到的假钥匙会泛红光并带骷髅标记，可以直接绕开它们。' },
  3: { name: '终点透视', desc: '集齐真钥匙后，你能直接看到终点在迷宫中的位置（含迷雾之外），带大家过去。' },
  4: { name: '透视队友', desc: '能透过迷雾看到所有队友的位置（含迷雾之外），落单时也能找到人。' }
};

const COLOR_KEY = 'escape_color';
const NAME_KEY = 'escape_name';
const TURN_KEY = 'escape_turn_on';
const NAME_MAX = 8;

/** 座位名会拼进 innerHTML，别人的名字属于不可信输入，必须转义 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 颜色同理：只接受 #rgb / #rrggbb(aa)，别的一律退回白色，免得拼进 style 里出事 */
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#ffffff';
}

/** 中继预设里「自定义」的哨兵值；其余 option 的 value 就是逗号分隔的 wss 列表 */
const RELAY_CUSTOM = 'custom';

export function fmtTime(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function createUI() {
  const $ = id => document.getElementById(id);
  const els = {
    ovStart: $('ovStart'), startView: $('startView'), lobbyView: $('lobbyView'),
    ovAbility: $('ovAbility'), ovReview: $('ovReview'),
    btnStart: $('btnStart'), btnCreateRoom: $('btnCreateRoom'), btnJoinRoom: $('btnJoinRoom'),
    btnResume: $('btnResume'), startTip: $('startTip'),
    btnCopyInvite: $('btnCopyInvite'), btnLeaveRoom: $('btnLeaveRoom'), btnStartGame: $('btnStartGame'),
    roomCode: $('roomCode'), roomInput: $('roomInput'), roster: $('roster'),
    nameInput: $('nameInput'), nameInputLobby: $('nameInputLobby'),
    btnAddBot: $('btnAddBot'), btnRemoveBot: $('btnRemoveBot'),
    relayStrategy: $('relayStrategy'), relayPreset: $('relayPreset'), relayUrl: $('relayUrl'),
    lobbyStatus: $('lobbyStatus'),
    turnOn: $('turnOn'), btnNetCheck: $('btnNetCheck'), netNote: $('netNote'),
    colorPreview: $('colorPreview'), swatches: $('swatches'), cpick: $('cpick'),
    abilityName: $('abilityName'), abilityDesc: $('abilityDesc'),
    abilityClosedCount: $('abilityClosedCount'), btnAbilityClose: $('btnAbilityClose'),
    rvTitle: $('rvTitle'), rvTotal: $('rvTotal'), rvKeys: $('rvKeys'), rvGather: $('rvGather'),
    rvKeyTotal: $('rvKeyTotal'), rvFakePicked: $('rvFakePicked'), rvPerPlayer: $('rvPerPlayer'),
    rvDmg: $('rvDmg'), rvRevive: $('rvRevive'),
    btnBackToRoom: $('btnBackToRoom'),
    hud: $('hud'), hudHearts: $('hudHearts'), hudKeys: $('hudKeys'), hudAbility: $('hudAbility'),
    hudTimer: $('hudTimer'), hudRoom: $('hudRoom'),
    btnWall: $('btnWall'), btnRevive: $('btnRevive'), btnSpecPrev: $('btnSpecPrev'), btnSpecNext: $('btnSpecNext'),
    btnKb: $('btnKb'), kbLabel: $('kbLabel'), pad: $('pad'), toast: $('toast'),
    toolbar: $('toolbar'), btnBackRoomTop: $('btnBackRoomTop'),
    stage: $('stage'), stagewrap: $('stagewrap'), side: $('side'), cv: $('cv'), wrap: $('wrap'),
    musicbar: $('musicbar'), actionRow: $('actionRow'), app: $('app')
  };

  let color = '#ffffff';
  try { color = localStorage.getItem(COLOR_KEY) || '#ffffff'; } catch (e) { color = '#ffffff'; }
  let handlers = {};
  // 免费 TURN 开关：默认开。关掉只留 STUN，严格 NAT 下就别指望能连上了
  let turnOn = true;
  try { turnOn = localStorage.getItem(TURN_KEY) !== '0'; } catch (e) { turnOn = true; }
  els.turnOn.checked = turnOn;
  let toastTimer = 0;
  let relayLocked = false;   // 房间一建好，中继策略就不能再改

  function setColor(c, notify) {
    color = c;
    els.colorPreview.style.background = c;
    els.cpick.value = c;
    const kids = els.swatches.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('on', kids[i].getAttribute('data-color') === c);
    }
    try { localStorage.setItem(COLOR_KEY, c); } catch (e) {}
    if (notify && handlers.onColor) handlers.onColor(c);
  }

  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('data-color', c);
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c, true));
    els.swatches.appendChild(b);
  });
  els.cpick.addEventListener('input', () => setColor(els.cpick.value, true));
  els.cpick.addEventListener('change', () => setColor(els.cpick.value, true));
  setColor(color, false);

  /* 名字：开场页填一次，进房后还能在大厅改。两个输入框共用同一份状态，
     只写「不是当前正在打字的那个」，否则光标会被打回开头。 */
  let myName = '';
  try { myName = String(localStorage.getItem(NAME_KEY) || '').slice(0, NAME_MAX); } catch (e) { myName = ''; }

  function applyName(v, src) {
    myName = String(v || '').trim().slice(0, NAME_MAX);
    if (src !== 'start') els.nameInput.value = myName;
    if (src !== 'lobby') els.nameInputLobby.value = myName;
    try { localStorage.setItem(NAME_KEY, myName); } catch (e) {}
  }
  applyName(myName);
  els.nameInput.addEventListener('input', () => applyName(els.nameInput.value, 'start'));
  els.nameInputLobby.addEventListener('input', () => applyName(els.nameInputLobby.value, 'lobby'));
  // 逐字上报会把 setProfile 打成每字一条广播，失焦 / 回车时才提交
  const commitName = () => { if (handlers.onName) handlers.onName(myName); };
  els.nameInput.addEventListener('change', commitName);
  els.nameInputLobby.addEventListener('change', commitName);

  function bind(h) {
    handlers = h || {};
    const on = (el, fn) => el && el.addEventListener('click', fn);
    on(els.btnStart, () => handlers.onStart && handlers.onStart());
    on(els.btnCreateRoom, () => handlers.onCreate && handlers.onCreate());
    on(els.btnJoinRoom, () => handlers.onJoin && handlers.onJoin(els.roomInput.value.trim()));
    on(els.btnCopyInvite, () => handlers.onCopyInvite && handlers.onCopyInvite());
    on(els.btnLeaveRoom, () => handlers.onLeave && handlers.onLeave());
    on(els.btnStartGame, () => handlers.onStartGame && handlers.onStartGame());
    on(els.btnAddBot, () => handlers.onAddBot && handlers.onAddBot());
    on(els.btnRemoveBot, () => handlers.onRemoveBot && handlers.onRemoveBot());
    on(els.btnResume, () => handlers.onResume && handlers.onResume());
    on(els.btnAbilityClose, () => handlers.onAbilityClose && handlers.onAbilityClose());
    on(els.btnBackToRoom, () => handlers.onBackToRoom && handlers.onBackToRoom());
    on(els.btnBackRoomTop, () => handlers.onBackRoomTop && handlers.onBackRoomTop());
    on(els.btnWall, () => handlers.onWall && handlers.onWall());
    on(els.btnRevive, () => handlers.onRevive && handlers.onRevive());
    on(els.btnSpecPrev, () => handlers.onSpec && handlers.onSpec(-1));
    on(els.btnSpecNext, () => handlers.onSpec && handlers.onSpec(1));
    els.relayStrategy.addEventListener('change', () => { syncRelay(); notifyRelay(); });
    els.relayPreset.addEventListener('change', () => {
      if (els.relayPreset.value === RELAY_CUSTOM) els.relayUrl.focus();
      syncRelay();
      notifyRelay();
    });
    els.relayUrl.addEventListener('change', notifyRelay);
    els.turnOn.addEventListener('change', () => {
      setTurnOn(els.turnOn.checked);
      if (handlers.onTurnChange) handlers.onTurnChange(els.turnOn.checked);
    });
    on(els.btnNetCheck, () => handlers.onNetCheck && handlers.onNetCheck());
    on(els.btnKb, () => {
      const show = els.pad.classList.toggle('show');
      els.kbLabel.textContent = show ? '收起虚拟按钮' : '呼出虚拟按钮';
      els.btnKb.classList.toggle('active', show);
      // 极矮视口键盘可能超出视口，展开时允许 .wrap 内部滚动到底
      document.body.classList.toggle('pad-open', show);
    });
  }

  function showOnly(name) {
    const showStart = name === 'intro' || name === 'lobby';
    els.ovStart.classList.toggle('show', showStart);
    els.ovAbility.classList.toggle('show', name === 'abilities');
    els.ovReview.classList.toggle('show', name === 'review');
    els.startView.hidden = name !== 'intro';
    els.lobbyView.hidden = name !== 'lobby';
    els.hud.classList.toggle('show', name === 'playing');
  }

  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function setLobbyStatus(text) { els.lobbyStatus.textContent = text; }

  /** 开场页的「回到上次的房间」：给房间号就不显示；空串 = 收起 */
  function setResume(roomId, short) {
    const on = !!roomId;
    els.btnResume.hidden = !on;
    if (on) els.btnResume.textContent = short ? '回到房间 ' + short : '回到上次的房间';
    els.startTip.textContent = on
      ? '上次在房间 ' + (short || '') + ' 里，点上面按钮直接回去（可能是进行中的对局）'
      : '4 人开局 · 房主为裁判 · 人数不够可在房间内添加人机';
  }

  /** 「返回房间」只给房主、且只在局内亮；用 disabled 而不是 hidden，
      让它始终撑住工具条高度（see .toolbar 注释）。 */
  function setBackRoom(canUse) { els.btnBackRoomTop.disabled = !canUse; }

  function renderLobby(d) {
    els.roomCode.textContent = d.roomCode || '------';
    els.btnStartGame.hidden = !d.isHost;
    els.btnStartGame.disabled = !d.canStart;
    els.btnStartGame.textContent = d.isHost
      ? (d.canStart ? '开始游戏' : '等待玩家 ' + d.userCount + ' / 4')
      : '等待房主开始';
    els.btnCopyInvite.hidden = !d.roomId;
    // 「离开房间」只对真的在房间里的人有意义：刚进大厅还没建房/进房时它没有对象，
    // 点了也只是把不存在的东西关掉，反而让人以为自己已经在房内。回首页走页面顶部「← 返回」。
    els.btnLeaveRoom.hidden = !d.roomId;
    els.btnCreateRoom.hidden = !!d.roomId;
    els.btnJoinRoom.hidden = !!d.roomId;
    els.roomInput.hidden = !!d.roomId;
    relayLocked = !!d.roomId;
    syncRelay();
    // 人机只由房主添加 / 移除；座位满了就只剩「移除人机」
    els.btnAddBot.hidden = !d.canAddBot;
    els.btnRemoveBot.hidden = !d.canRemoveBot;

    let html = '';
    for (let i = 0; i < 4; i++) {
      const u = d.users[i];
      if (!u) { html += '<div class="seat empty"><span class="dot"></span><span class="who">空位</span></div>'; continue; }
      // 名字是玩家自己填的，必须转义后再拼；颜色也要过一遍白名单
      const who = u.self ? '我' : esc(u.short || '玩家');
      const role = u.bot ? '人机' : (u.host ? '房主' : '玩家');
      html += '<div class="seat' + (u.bot ? ' bot' : '') + '"><span class="dot" style="background:' + safeColor(u.color) + '"></span>' +
        '<span class="who">' + who + '</span>' +
        '<span class="tag">' + role + '</span></div>';
    }
    els.roster.innerHTML = html;
    if (d.status) setLobbyStatus(d.status);
  }

  function renderAbility(d) {
    const info = ABILITY_INFO[d.ability] || { name: '--', desc: '--' };
    els.abilityName.textContent = info.name;
    els.abilityDesc.textContent = info.desc;
    els.abilityClosedCount.textContent = '已确认 ' + d.closedCount + ' / 4' + (d.closed ? '（你已确认）' : '');
    els.btnAbilityClose.disabled = !!d.closed;
    els.btnAbilityClose.textContent = d.closed ? '等待队友…' : '关闭';
  }

  function renderHUD(d) {
    const hearts = els.hudHearts.children;
    for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('off', i >= d.hp);
    els.hudHearts.classList.toggle('live', d.hp === 1 && d.alive);
    els.hudKeys.textContent = '真钥匙 ' + d.realTaken + ' / ' + d.realTotal;
    els.hudAbility.textContent = '能力 ' + ((ABILITY_INFO[d.ability] || {}).name || '--');
    els.hudTimer.textContent = fmtTime(d.elapsed);
    els.hudRoom.textContent = d.roomCode || '--';
  }

  function renderButtons(d) {
    els.btnWall.hidden = !d.showWall;
    els.btnWall.textContent = '穿墙 ×' + d.wallCharges;
    els.btnWall.disabled = !d.wallCharges;
    els.btnRevive.hidden = !d.showRevive;
    if (d.showRevive) els.btnRevive.textContent = '抢救 ' + (d.reviveName || '队友');
    els.btnSpecPrev.hidden = !d.spectating;
    els.btnSpecNext.hidden = !d.spectating;
  }

  function showReview(d) {
    els.rvTitle.textContent = d.win ? '逃生成功' : '逃生失败';
    els.rvTotal.textContent = fmtTime(d.timings.total);
    els.rvKeys.textContent = fmtTime(d.timings.keys);
    els.rvGather.textContent = fmtTime(d.timings.gather);
    els.rvKeyTotal.textContent = d.realTotal + ' 把真 / ' + d.fakeTotal + ' 把假';
    els.rvFakePicked.textContent = d.fakePicked + ' 次';
    els.rvDmg.textContent = d.dmgFake + ' 次 / ' + d.dmgMonster + ' 次';
    els.rvRevive.textContent = d.reviveCount + ' 次';

    let a = '';
    for (let i = 0; i < d.perPlayer.length; i++) {
      const p = d.perPlayer[i];
      a += '<div class="rv-row"><span class="dot" style="background:' + p.color + '"></span>' +
        '<span class="txt">' + p.name + '：真 ' + p.real + ' · 假 ' + p.fake + '</span></div>';
    }
    els.rvPerPlayer.innerHTML = a || '<div class="rv-row"><span class="txt">无记录</span></div>';
  }

  /* ---- 中继：预设下拉 = 快捷填充，选「自定义」才露出输入框 ---- */
  function matchPreset(url) {
    if (!url) return '';
    const opts = els.relayPreset.options;
    for (let i = 0; i < opts.length; i++) if (opts[i].value === url) return url;
    return RELAY_CUSTOM;
  }

  /** 当前生效的中继地址串（逗号分隔）；空串 = 用内置池 */
  function currentRelayUrl() {
    const v = els.relayPreset.value;
    return v === RELAY_CUSTOM ? els.relayUrl.value.trim() : v;
  }

  /** 锁房间 / BitTorrent 不适用 wss 中继 / 自定义才显示输入框，统一在这里收口 */
  function syncRelay() {
    const torrent = els.relayStrategy.value === 'torrent';
    const custom = els.relayPreset.value === RELAY_CUSTOM;
    els.relayStrategy.disabled = relayLocked;
    els.relayPreset.disabled = relayLocked || torrent;
    els.relayUrl.disabled = relayLocked || torrent;
    els.relayUrl.hidden = !custom;
    els.turnOn.disabled = relayLocked;
    els.relayPreset.title = torrent
      ? 'BitTorrent 用公共 Tracker，不需要 wss 中继'
      : 'Nostr 中继预设（' + (currentRelayUrl() || '内置池随机 5 条') + '）';
  }

  function notifyRelay() {
    if (handlers.onRelayChange) handlers.onRelayChange(els.relayStrategy.value, currentRelayUrl());
  }

  function setRelayUI(strategy, url) {
    els.relayStrategy.value = strategy;
    els.relayUrl.value = url || '';
    els.relayPreset.value = matchPreset(url || '');
    syncRelay();
  }
  function getRelayUI() { return { strategy: els.relayStrategy.value, url: currentRelayUrl() }; }

  /* ---- 穿透开关 / 网络自检结果 ---- */
  function setTurnOn(v) {
    turnOn = v !== false;
    els.turnOn.checked = turnOn;
    try { localStorage.setItem(TURN_KEY, turnOn ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
  }
  function getTurnOn() { return turnOn; }
  function setNetNote(text, tone) {
    els.netNote.textContent = text || '';
    els.netNote.hidden = !text;
    els.netNote.className = 'ov-tip net-note' + (tone ? ' ' + tone : '');
  }
  function getRoomInput() { return els.roomInput.value.trim(); }
  function setRoomInput(v) { els.roomInput.value = v; }
  function getColor() { return color; }
  function getName() { return myName; }

  return {
    els, bind, showOnly, toast, setLobbyStatus, setBackRoom, renderLobby, renderAbility,
    setResume,
    renderHUD, renderButtons, showReview, setRelayUI, getRelayUI,
    setTurnOn, getTurnOn, setNetNote,
    getRoomInput, setRoomInput, getColor, setColor, getName
  };
}
