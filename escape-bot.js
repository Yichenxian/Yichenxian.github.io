/* ============================================================
   合作逃生 · 人机队友（房主单端执行，纯逻辑、无 DOM 依赖）
   行为顺序：最近的真钥匙 → 钥匙集齐后去终点等玩家
            途中怪物路径距离 ≤ THREAT_R 就转身逃（flee）
            玩家已到终点则不再躲避，直接冲终点汇合（rush）
   人机只认真钥匙：假钥匙留给人类用能力判断，人机不作弊也不白掉血。
   ============================================================ */

import { idx, xOf, yOf, bfsDistances, bfsStep } from './escape-map.js?v=20261114f';

export const BOT = {
  STEP_MS: 270,       // 常规移动间隔（玩家按住键是 160ms，人机略慢）
  FLEE_MS: 160,       // 逃跑间隔：快过怪物追击的 320ms，才可能真正甩掉它
  RUSH_MS: 180,       // 冲向终点汇合时提速
  PATH_MS: 520,       // 路径 / 目标重算间隔
  FLEE_REPLAN_MS: 350,// 逃跑落点重算间隔
  FLEE_HORIZON: 12,   // 逃跑时最多往前看多少步
  THREAT_R: 3,        // 怪物路径距离 ≤ 3 视为威胁 → 逃
  DANGER_STEP: 1      // 工作态不主动踏进怪物 1 格内，原地等它走开
};

export function createBot(meta, cellI) {
  return {
    id: meta.id,
    name: meta.name,
    color: meta.color,
    x: xOf(cellI),
    y: yOf(cellI),
    st: 'work',
    destI: -1,
    dist: null,
    pathAt: 0,
    fleeDestI: -1,
    fleeDist: null,
    fleeAt: 0,
    nextMoveAt: 0
  };
}

/** 选最近的「没被其它人机预定」的真钥匙；全被预定就允许共享 */
function pickKeyTarget(grid, curI, targets, reserved) {
  const from = bfsDistances(grid, curI);
  let best = -1, bestD = 32767;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (reserved && reserved.has(t)) continue;
    const d = from[t];
    if (d < 0) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  if (best < 0 && reserved) return pickKeyTarget(grid, curI, targets, null);
  return best;
}

/** 怪物距离场按「地图 + 怪物格」缓存：一帧只变几次，不必每帧重算 51×51 BFS */
let mField = { grid: null, i: -1, dist: null };
function monsterField(grid, i) {
  if (mField.grid === grid && mField.i === i && mField.dist) return mField.dist;
  const dist = bfsDistances(grid, i);
  mField = { grid, i, dist };
  return dist;
}

/**
 * 逃跑落点：在「自己 FLEE_HORIZON 步内能到」的格子里挑离怪物最远的那格。
 * 只做贪心爬升会一头钻进死胡同（死胡同正是距离场的局部极大值），所以要看远一点。
 */
function fleeDest(grid, mDist, curI, monsterI) {
  const from = bfsDistances(grid, curI);
  let best = -1, bestScore = -1;
  for (let i = 0; i < from.length; i++) {
    if (grid[i] !== 0 || from[i] < 0 || from[i] > BOT.FLEE_HORIZON) continue;
    if (i === monsterI) continue;
    const md = mDist[i] >= 0 ? mDist[i] : 9999;
    const score = md * 100 - from[i];      // 先比离怪多远，同样远再比少走几步
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * 推进所有人机一帧；now 为毫秒时间戳（与 requestAnimationFrame 同源）。
 * ctx = { grid, targets:[真钥匙格索引], exitI, exitActive, playerAtExit, monster:{x,y}|null }
 * 返回本帧真的走了一格的人机数组，调用方据此同步权威格位 + 收钥匙。
 */
export function tickBots(bots, ctx, now) {
  const grid = ctx.grid;
  const rush = !!ctx.playerAtExit;
  const monsterI = ctx.monster ? idx(ctx.monster.x, ctx.monster.y) : -1;
  const reserved = new Set();
  const moved = [];
  // 怪物距离场一帧算一次，全队共用
  const mDist = (monsterI >= 0 && !rush) ? monsterField(grid, monsterI) : null;

  for (let k = 0; k < bots.length; k++) {
    const b = bots[k];
    const curI = idx(b.x, b.y);
    const curM = mDist ? mDist[curI] : -1;
    b.st = rush ? 'rush' : (mDist && curM >= 0 && curM <= BOT.THREAT_R ? 'flee' : 'work');

    // 已经在终点等着玩家（含 rush 状态），不用再算路径
    if (b.st !== 'flee' && ctx.exitActive && curI === ctx.exitI) {
      b.destI = ctx.exitI;
      b.dist = null;
      b.nextMoveAt = now + BOT.STEP_MS;
      reserved.add(ctx.exitI);
      continue;
    }
    if (now < b.nextMoveAt) {
      if (b.destI >= 0) reserved.add(b.destI);
      continue;
    }

    let step = -1;
    if (b.st === 'flee') {
      if (b.fleeDestI < 0 || !b.fleeDist || now - b.fleeAt > BOT.FLEE_REPLAN_MS) {
        b.fleeDestI = fleeDest(grid, mDist, curI, monsterI);
        b.fleeDist = b.fleeDestI >= 0 ? bfsDistances(grid, b.fleeDestI) : null;
        b.fleeAt = now;
      }
      if (b.fleeDist) step = bfsStep(grid, b.fleeDist, curI);
      // 落点就是脚下 = 退无可退，先原地等（避免每帧重算两次 BFS）
      if (step < 0 && b.fleeDestI !== curI) { b.fleeDestI = -1; b.fleeDist = null; }
    } else {
      b.fleeDestI = -1;
      b.fleeDist = null;
      const stale = ctx.exitActive
        ? b.destI !== ctx.exitI
        : ctx.targets.indexOf(b.destI) < 0;
      if (b.destI < 0 || stale || now - b.pathAt > BOT.PATH_MS) {
        const dest = ctx.exitActive ? ctx.exitI : pickKeyTarget(grid, curI, ctx.targets, reserved);
        b.destI = dest >= 0 ? dest : ctx.exitI;
        b.dist = b.destI >= 0 ? bfsDistances(grid, b.destI) : null;
        b.pathAt = now;
      }
      if (b.dist) step = bfsStep(grid, b.dist, curI);
      if (step < 0) {
        b.dist = null;
        b.destI = -1;
      } else if (b.st === 'work') {
        const sd = mDist ? mDist[step] : -1;
        if (sd >= 0 && sd <= BOT.DANGER_STEP) step = -1;   // 怪物贴身，先等它走开
      }
    }

    // 任何状态都不主动踩进怪物格：rush 只是不再绕路，不是去送死
    if (step >= 0 && step !== monsterI) {
      b.x = xOf(step);
      b.y = yOf(step);
      moved.push(b);
    }
    if (b.destI >= 0) reserved.add(b.destI);
    b.nextMoveAt = now + (b.st === 'rush' ? BOT.RUSH_MS : (b.st === 'flee' ? BOT.FLEE_MS : BOT.STEP_MS));
  }
  return moved;
}
