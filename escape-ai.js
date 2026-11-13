/* ============================================================
   合作逃生 · 怪物 AI（房主单端执行）
   WANDER 终点周围缓慢游荡 → 看到玩家 CHASE 加速追击 → 脱战 RETURN 回巢
   视野规则与玩家相同但范围 8 格（玩家 2 倍），不可穿墙
   ============================================================ */

import { N, idx, xOf, yOf, bfsDistances, bfsStep, CFG } from './escape-map.js?v=20261113l';
import { computeSight, MONSTER_SIGHT } from './escape-fog.js?v=20261113l';

export const AI = {
  ROAM_MS: 470,          // 游荡：约 2.1 格/秒
  CHASE_MS: 200,         // 追击：约 5 格/秒 = 玩家 80%
  RETURN_MS: 360,        // 回巢
  DEAGGRO_MS: 2500,      // 连续看不到玩家后脱战
  PATH_RECALC_MS: 300,   // 追击路径重算间隔
  HOME_R: CFG.MONSTER_HOME_R
};

export function createMonster(homeI, rng) {
  return {
    x: xOf(homeI), y: yOf(homeI),
    homeI,
    st: 'wander',
    target: null,
    lastSeenAt: 0,
    pathAt: 0,
    destI: homeI,
    dist: null,
    homeDist: null,
    nextMoveAt: 0,
    rng
  };
}

function pickWanderDest(grid, m) {
  if (!m.homeDist) m.homeDist = bfsDistances(grid, m.homeI);
  const pool = [];
  for (let i = 0; i < N * N; i++) {
    if (grid[i] === 0 && m.homeDist[i] >= 0 && m.homeDist[i] <= AI.HOME_R) pool.push(i);
  }
  if (!pool.length) return m.homeI;
  return pool[Math.floor(m.rng() * pool.length)];
}

function visiblePlayers(grid, m, players) {
  const sight = computeSight(grid, m.x, m.y, MONSTER_SIGHT, 1);
  const out = [];
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    if (!p.alive) continue;
    if (sight.lit[idx(p.x, p.y)]) out.push(p);
  }
  return out;
}

/**
 * 推进一帧；now 为毫秒时间戳。
 * 返回本帧产生的碰撞事件数组 [{type:'MONSTER_HIT', userId}]
 */
export function tickMonster(m, grid, players, now) {
  const events = [];
  const seen = visiblePlayers(grid, m, players);

  if (seen.length) {
    let best = seen[0], bestD = Infinity;
    for (let k = 0; k < seen.length; k++) {
      const p = seen[k];
      const d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    m.st = 'chase';
    m.target = best.id;
    m.lastSeenAt = now;
  } else if (m.st === 'chase' && now - m.lastSeenAt > AI.DEAGGRO_MS) {
    m.st = 'return';
    m.target = null;
    m.dist = null;
  }

  const interval = m.st === 'chase' ? AI.CHASE_MS : (m.st === 'return' ? AI.RETURN_MS : AI.ROAM_MS);
  const curI = idx(m.x, m.y);

  if (m.st === 'return' && m.homeDist && m.homeDist[curI] <= AI.HOME_R) {
    m.st = 'wander';
    m.dist = null;
    m.target = null;
  }

  if (now >= m.nextMoveAt) {
    if (m.st === 'wander') {
      if (!m.dist || m.destI === curI || bfsStep(grid, m.dist, curI) < 0) {
        m.destI = pickWanderDest(grid, m);
        m.dist = bfsDistances(grid, m.destI);
      }
    } else if (m.st === 'chase') {
      let tp = null;
      for (let k = 0; k < players.length; k++) if (players[k].id === m.target) { tp = players[k]; break; }
      if (tp) {
        const dest = idx(tp.x, tp.y);
        if (!m.dist || m.destI !== dest || now - m.pathAt > AI.PATH_RECALC_MS) {
          m.destI = dest;
          m.dist = bfsDistances(grid, dest);
          m.pathAt = now;
        }
      }
    } else {
      if (!m.dist || m.destI !== m.homeI) {
        m.destI = m.homeI;
        m.dist = bfsDistances(grid, m.homeI);
      }
    }

    const step = m.dist ? bfsStep(grid, m.dist, curI) : -1;
    if (step >= 0) { m.x = xOf(step); m.y = yOf(step); }
    m.nextMoveAt = now + interval;
  }

  // 贴身判定：同一格且不在无敌帧内
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    if (!p.alive) continue;
    if (p.x === m.x && p.y === m.y && now >= (p.invulnUntil || 0)) {
      events.push({ type: 'MONSTER_HIT', userId: p.id });
    }
  }
  return events;
}

/** 只广播这几项，避免把 BFS 距离场塞进网络状态 */
export function publicMonster(m) {
  return { x: m.x, y: m.y, st: m.st, target: m.target };
}
