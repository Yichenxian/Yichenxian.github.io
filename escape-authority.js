/* ============================================================
   合作逃生 · 房主权威规则（开局 / 扣血 / 判定结束 / 复盘数字）
   只负责"这一局的规则和数据"，不碰 DOM、不碰联机胶水：
   需要外部能力时走 createAuthority(fx) 注入，主控那边一次性接线。
   A 是**稳定引用**——只就地重置，从不整体替换，所以外部可以放心持有它。
   ============================================================ */

import {
  idx, CFG, makeRng, shuffle, generateMap, publicMapInfo
} from './escape-map.js?v=20261113l';
import { createMonster } from './escape-ai.js?v=20261113l';
import { createBot } from './escape-bot.js?v=20261113l';

/** 受伤后的无敌时间；主控的 tryRevive 也要用，所以从这里导出 */
export const INVULN_MS = 900;

function fresh() {
  return {
    roundId: 0, phase: 'lobby', map: null, info: null, grid: null,
    players: {}, abilities: {}, taken: {}, realTaken: 0, fakePicked: 0,
    allyUnlocked: false, exitActive: false, monster: null,
    startedAt: 0, keysDoneAt: 0, endedAt: 0, win: false,
    stats: { dmgFake: 0, dmgMonster: 0, reviveCount: 0 },
    review: null, lastSeq: {}, evtId: 0,
    // 本局发给每个人的「真假钥匙」定向数据。玩家刷新重进时按它补发，
    // 否则能力 1/2 的人会丢掉透视与假钥匙标记（公开状态里绝不能带，那是剧透）
    reveals: null
  };
}

/**
 * @param fx {
 *   isHost, joined, selfId, userIds, toast,            // 外部事实与提示
 *   botInfo, isBotId, colorOf, shortName,              // 名册查询
 *   syncMap(grid, mapHash), resetView(),               // 开局要把新地图 / 客端缓存交给主控
 *   handleReveal(payload), sendReveal(id, payload),    // 定向数据（能力 1/2）
 *   publish(), emit(evt)                               // 广播与飘字
 * }
 */
export function createAuthority(fx) {
  const A = fresh();
  // 本局人机行动体（房主单端模拟）。跟 A 一样用稳定数组，只清空不换引用。
  const bots = [];

  /** 就地重置：引用不变，外部持有的 A 仍然有效 */
  function resetA() { Object.assign(A, fresh()); }

  function emptyReview() {
    return {
      win: false,
      timings: { total: 0, keys: 0, gather: 0 },
      realTotal: 0, fakeTotal: 0, fakePicked: 0,
      dmgFake: 0, dmgMonster: 0, reviveCount: 0,
      perPlayer: []
    };
  }

  function startGame() {
    if (!fx.isHost() || !fx.joined() || !fx.selfId()) return;
    const ids = fx.userIds();
    if (ids.length !== 4) { fx.toast('必须满 4 人才能开始（可添加人机补位）'); return; }

    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    const map = generateMap(seed);
    const nextRound = A.roundId + 1;
    resetA();
    A.map = map;
    A.info = publicMapInfo(map);
    A.grid = map.grid;
    fx.syncMap(map.grid, map.mapHash);
    A.roundId = nextRound;
    A.phase = 'abilities';
    // 客端/渲染层那些"上一局残留"一起清掉（视野缓存、已揭示信息、按键状态…）
    fx.resetView();
    bots.length = 0;

    const abilities = shuffle([1, 2, 3, 4], makeRng(seed ^ 0x5bd1e995));
    ids.forEach((id, n) => {
      const s = map.spawns[n];
      A.abilities[id] = abilities[n];
      A.players[id] = {
        id, x: s.x, y: s.y, hp: CFG.HP_MAX, alive: true, reviveUsed: false,
        invulnUntil: 0, wallCharges: abilities[n] === 4 ? 1 : 0,
        keysReal: 0, keysFake: 0,
        dmgByFake: 0, dmgByMonster: 0, wallUses: 0, seenFakes: []
      };
    });
    // 人机在本局生成行动体：格位与权威玩家表一一对应
    ids.forEach(id => {
      const meta = fx.botInfo(id);
      if (!meta) return;
      const p = A.players[id];
      bots.push(createBot({ id: meta.id, name: meta.name, color: meta.color }, idx(p.x, p.y)));
    });
    A.monster = createMonster(map.monsterHomeI, makeRng(seed ^ 0x27d4eb2d));
    fx.publish();

    A.reveals = {};
    ids.forEach(id => {
      if (fx.isBotId(id)) return;                   // 人机不需要真假钥匙提示
      const payload = {
        roundId: A.roundId,
        keyIds: abilities[ids.indexOf(id)] === 1 ? map.keyIds.slice() : [],
        fakeIds: abilities[ids.indexOf(id)] === 2 ? map.fakeIds.slice() : []
      };
      A.reveals[id] = payload;
      if (id === fx.selfId()) fx.handleReveal(payload);
      else fx.sendReveal(id, payload);
    });
  }

  function damage(u, cause) {
    const p = A.players[u];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now < p.invulnUntil) return;
    p.hp--;
    p.invulnUntil = now + INVULN_MS;
    if (cause === 'fake') { A.stats.dmgFake++; p.dmgByFake++; }
    else { A.stats.dmgMonster++; p.dmgByMonster++; }
    fx.emit({ type: 'DAMAGE', userId: u, cause, hpAfter: p.hp });
    if (p.hp <= 0) {
      p.alive = false;
      fx.emit({ type: 'DEATH', userId: u, reviveUsed: p.reviveUsed });
      checkEnd();
    }
  }

  function checkEnd() {
    if (A.phase !== 'playing' || !A.info) return;
    const ids = Object.keys(A.players);
    const alive = ids.filter(id => A.players[id].alive);
    if (!alive.length) { endGame(false); return; }
    if (A.exitActive && A.info.exitI >= 0 &&
        alive.every(id => idx(A.players[id].x, A.players[id].y) === A.info.exitI)) {
      endGame(true);
    }
  }

  function buildReview() {
    const ids = Object.keys(A.players);
    const perPlayer = ids.map(id => ({
      color: fx.colorOf(id), name: fx.shortName(id),
      real: A.players[id].keysReal, fake: A.players[id].keysFake
    }));
    const end = A.endedAt || Date.now();
    const keysAt = A.keysDoneAt || end;
    return {
      win: A.win,
      timings: {
        total: end - A.startedAt,
        keys: keysAt - A.startedAt,
        gather: end - keysAt
      },
      realTotal: A.info.realTotal,
      fakeTotal: A.info.fakeTotal,
      fakePicked: A.fakePicked,
      dmgFake: A.stats.dmgFake,
      dmgMonster: A.stats.dmgMonster,
      reviveCount: A.stats.reviveCount,
      perPlayer
    };
  }

  function endGame(win) {
    if (A.phase === 'review') return;
    A.win = win;
    A.endedAt = Date.now();
    A.phase = 'review';
    A.review = buildReview();
    fx.publish();
    fx.emit({ type: win ? 'WIN' : 'LOSE' });
  }

  return { A, bots, resetA, startGame, damage, checkEnd, endGame, emptyReview, buildReview };
}
