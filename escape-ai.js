/* ============================================================
   合作逃生 · 怪物 AI（房主单端执行）
   WANDER 终点周围缓慢游荡 → 看到玩家 CHASE 加速追击 → 脱战 RETURN 回巢
   怪物刻意用窄十字视野（computeSight 的 peek 固定传 1）看 5 格，
   比玩家的固定光圈「瞎」一些 —— 玩家拐个弯才能断线，不可穿墙

   甩脱手感的三条硬约束（改数值前先看 escape_chase_test.js）：
   ① 追击明显慢于玩家；② 视野只比玩家多一点，拐两个弯就能断线；
   ③ 追击态拐弯要付转身成本，否则单格走廊里怪物 BFS 抄近路零成本，
      玩家却要松手、看路、重按，「狭窄迷宫甩不掉」就是这么来的。
   ============================================================ */

import { N, idx, xOf, yOf, bfsDistances, bfsStep, CFG } from './escape-map.js?v=20261114f';
import { computeSight, MONSTER_SIGHT } from './escape-fog.js?v=20261114f';

export const AI = {
  ROAM_MS: 470,          // 游荡：约 2.1 格/秒
  CHASE_MS: 320,         // 追击：约 3.1 格/秒 = 玩家(160) 的 50%，直线能明显拉开
  RETURN_MS: 360,        // 回巢：约 2.8 格/秒
  TURN_MS: 180,          // 追击态每次改变方向额外停顿（只罚追击，游荡不卡顿）
  DEAGGRO_MS: 800,       // 丢视野后最多再追 0.8 秒，之后强制回巢
  STUN_MS: 900,          // 撞人后自身僵直：完整覆盖玩家 900ms 无敌窗口
  HIT_REACH: 1,          // 撞击判定：同格或相邻一格（曼哈顿距离）
  HOME_R: CFG.MONSTER_HOME_R
};

export function createMonster(homeI, rng) {
  return {
    x: xOf(homeI), y: yOf(homeI),
    homeI,
    st: 'wander',
    target: null,
    lastSeenAt: 0,
    lastSeenI: -1,        // 最后一次「亲眼看见」玩家的格子，追击只认它，不认玩家实时坐标
    stunUntil: 0,         // 撞人后僵直到这个时刻
    stu: false,           // 是否正在僵直（只用于广播/渲染）
    destI: homeI,
    dist: null,
    homeDist: null,
    nextMoveAt: 0,
    lastDir: 0,           // 上一格的方向（step-curI），用来判「这一步是不是拐弯」
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

  // 僵直：撞完人先缓一拍，既不动也不再判定，被追的人才有机会拉开
  if (now < m.stunUntil) { m.stu = true; return events; }
  m.stu = false;

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
    // 关键：只有这一帧真的看见了才更新追踪点。看不见时锁在旧位置，
    // 于是玩家拐进墙后躲起来，怪物只会跑去「最后看到的地方」，不会透视追人。
    m.lastSeenI = idx(best.x, best.y);
  } else if (m.st === 'chase' && now - m.lastSeenAt > AI.DEAGGRO_MS) {
    m.st = 'return';
    m.target = null;
    m.lastSeenI = -1;
    m.dist = null;
  }

  const interval = m.st === 'chase' ? AI.CHASE_MS : (m.st === 'return' ? AI.RETURN_MS : AI.ROAM_MS);
  const curI = idx(m.x, m.y);

  // homeDist 是懒加载的：怪物若开局就被激怒、从没游荡过，这里得自己补一次，
  // 否则永远切不回 wander，会一直卡在巢里空转。
  if (m.st === 'return') {
    if (!m.homeDist) m.homeDist = bfsDistances(grid, m.homeI);
    if (m.homeDist[curI] <= AI.HOME_R) {
      m.st = 'wander';
      m.dist = null;
      m.target = null;
      m.lastSeenI = -1;
    }
  }

  if (now >= m.nextMoveAt) {
    if (m.st === 'wander') {
      if (!m.dist || m.destI === curI || bfsStep(grid, m.dist, curI) < 0) {
        m.destI = pickWanderDest(grid, m);
        m.dist = bfsDistances(grid, m.destI);
      }
    } else if (m.st === 'chase') {
      const goal = m.lastSeenI;
      if (goal < 0) {
        m.st = 'return'; m.dist = null; m.target = null;
      } else if (goal === curI) {
        // 追到「最后看到的位置」，人已经不在了 → 果断回巢，别继续瞎猜
        m.st = 'return'; m.dist = null; m.target = null; m.lastSeenI = -1;
      } else if (!m.dist || m.destI !== goal) {
        // 目标格没变就不重算 BFS（玩家站着不动时省掉整张 51×51 距离场）
        m.destI = goal;
        m.dist = bfsDistances(grid, goal);
      }
    } else {
      if (!m.dist || m.destI !== m.homeI) {
        m.destI = m.homeI;
        m.dist = bfsDistances(grid, m.homeI);
      }
    }

    const step = m.dist ? bfsStep(grid, m.dist, curI) : -1;
    if (step >= 0) {
      const dir = step - curI;                    // ±1 是左右，±N 是上下
      const turned = m.lastDir !== 0 && dir !== m.lastDir;
      m.lastDir = dir;
      m.x = xOf(step); m.y = yOf(step);
      // 只罚追击态：玩家在单格走廊里换方向要松手 + 看路 + 重按（约 250ms），
      // 怪物若零成本转向就能靠 BFS 抄近路堵人。给它 180ms 转身成本，
      // 玩家直线跑的那一侧才真正占得到便宜。
      m.nextMoveAt = now + interval + (m.st === 'chase' && turned ? AI.TURN_MS : 0);
    } else {
      if (m.st === 'chase') { m.st = 'return'; m.dist = null; m.target = null; m.lastSeenI = -1; }
      m.nextMoveAt = now + interval;
    }
  }

  // 撞击判定：同格或相邻一格（迷宫里边相邻的通道格必然连通），且不在无敌帧内。
  // 原来是「必须同格」，而怪物比玩家慢半拍、追到的永远是玩家上一格，
  // 于是贴脸跟着跑却碰不到人 —— 放宽到相邻才咬得到。
  for (let k = 0; k < players.length; k++) {
    const p = players[k];
    if (!p.alive) continue;
    if (now < (p.invulnUntil || 0)) continue;
    const d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
    if (d > AI.HIT_REACH) continue;
    events.push({ type: 'MONSTER_HIT', userId: p.id });
    m.stunUntil = now + AI.STUN_MS;   // 咬完自己也喘一口，一次只咬一个人
    m.stu = true;
    break;
  }
  return events;
}

/** 只广播这几项，避免把 BFS 距离场塞进网络状态 */
export function publicMonster(m) {
  // 僵直借用 st 字段广播（不新增字段，客端/测试都按 4 项约定）
  return { x: m.x, y: m.y, st: m.stu ? 'stun' : m.st, target: m.target };
}
