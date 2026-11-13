/* ============================================================
   合作逃生 · 地图生成与网格工具（纯函数，无 DOM 依赖）
   逻辑网格 51×51（奇数），界面文案称「50×50」
   递归回溯 / Growing Tree 完美迷宫 → 死胡同钥匙房 → Braid 环路
   → 最远点采样出生 → minimax 终点 → 终点附近怪物 → BFS 校验
   ============================================================ */

export const N = 51;
export const TOTAL = N * N;

export const CFG = {
  BRANCH_P: 0.72,          // Growing Tree 取栈顶的概率
  BRAID_RATE: 0.8,         // 非钥匙死胡同打通成环路的概率
  KEY_RATIO: 0.09,         // 钥匙房占死胡同比例
  KEY_MIN: 8,
  KEY_MAX: 12,
  FAKE_RATE: 0.27,
  FAKE_MIN: 2,
  FAKE_MAX: 4,
  KEY_MIN_GAP: 12,         // 钥匙房之间最小路径距离
  KEY_MIN_SPAWN: 8,        // 钥匙房离出生点最小路径距离
  SPAWN_MIN_GAP: 12,       // 四出生点两两最小路径距离
  EXIT_MIN_DIST: 22,       // 终点离最近出生点的最小路径距离（开局摸不到）
  EXIT_KEY_MAX: 35,        // 终点到最远真钥匙的最大路径距离（51×70%）
  MONSTER_HOME_R: 6,       // 怪物游荡环带半径
  MONSTER_MIN_SPAWN: 16,   // 怪物离出生点最小路径距离
  ALLY_UNLOCK: 4,          // 累计真钥匙解锁队友透视
  HP_MAX: 3,
  MAX_RETRY: 30
};

export function idx(x, y) { return y * N + x; }
export function xOf(i) { return i % N; }
export function yOf(i) { return (i / N) | 0; }
export function inBounds(x, y) { return x >= 0 && x < N && y >= 0 && y < N; }

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const CARVE_DIRS = [[0, -2], [2, 0], [0, 2], [-2, 0]];

export function walkNeighbors(grid, i) {
  const out = [];
  const x = xOf(i), y = yOf(i);
  for (let d = 0; d < 4; d++) {
    const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
    if (inBounds(nx, ny)) {
      const ni = idx(nx, ny);
      if (grid[ni] === 0) out.push(ni);
    }
  }
  return out;
}

/** 从 startI 出发的 BFS 距离场；不可达为 -1 */
export function bfsDistances(grid, startI) {
  const dist = new Int16Array(TOTAL).fill(-1);
  if (grid[startI] !== 0) return dist;
  const queue = new Int32Array(TOTAL);
  let head = 0, tail = 0;
  queue[tail++] = startI;
  dist[startI] = 0;
  while (head < tail) {
    const cur = queue[head++];
    const nb = walkNeighbors(grid, cur);
    for (let k = 0; k < nb.length; k++) {
      const ni = nb[k];
      if (dist[ni] === -1) {
        dist[ni] = dist[cur] + 1;
        queue[tail++] = ni;
      }
    }
  }
  return dist;
}

/** 沿距离场朝目标走一格；返回目标格索引，无路可走返回 -1 */
export function bfsStep(grid, dist, fromI) {
  let best = -1, bestV = dist[fromI] < 0 ? 32767 : dist[fromI];
  const nb = walkNeighbors(grid, fromI);
  for (let k = 0; k < nb.length; k++) {
    const ni = nb[k];
    if (dist[ni] >= 0 && dist[ni] < bestV) { bestV = dist[ni]; best = ni; }
  }
  return best;
}

function carveMaze(grid, rng) {
  grid.fill(1);
  const visited = new Uint8Array(TOTAL);
  const active = [[1, 1]];
  grid[idx(1, 1)] = 0;
  visited[idx(1, 1)] = 1;
  while (active.length) {
    const k = rng() < CFG.BRANCH_P ? active.length - 1 : Math.floor(rng() * active.length);
    const cx = active[k][0], cy = active[k][1];
    const cands = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + CARVE_DIRS[d][0], ny = cy + CARVE_DIRS[d][1];
      if (nx <= 0 || nx >= N - 1 || ny <= 0 || ny >= N - 1) continue;
      if (visited[idx(nx, ny)]) continue;
      cands.push([nx, ny, cx + CARVE_DIRS[d][0] / 2, cy + CARVE_DIRS[d][1] / 2]);
    }
    if (!cands.length) { active.splice(k, 1); continue; }
    const pick = cands[Math.floor(rng() * cands.length)];
    grid[idx(pick[2], pick[3])] = 0;
    grid[idx(pick[0], pick[1])] = 0;
    visited[idx(pick[0], pick[1])] = 1;
    active.push([pick[0], pick[1]]);
  }
}

export function collectDeadEnds(grid) {
  const out = [];
  for (let i = 0; i < TOTAL; i++) {
    if (grid[i] !== 0) continue;
    if (walkNeighbors(grid, i).length === 1) out.push(i);
  }
  return out;
}

function spawnMinDistances(grid, spawns) {
  const min = new Int16Array(TOTAL).fill(32767);
  for (let s = 0; s < spawns.length; s++) {
    const d = bfsDistances(grid, spawns[s]);
    for (let i = 0; i < TOTAL; i++) {
      if (d[i] >= 0 && d[i] < min[i]) min[i] = d[i];
    }
  }
  return min;
}

/** 最远点采样：从 (1,1) 起，每次取「离已选点最小距离最大」的通路格 */
function pickSpawns(grid) {
  const spawns = [idx(1, 1)];
  const min = new Int16Array(TOTAL).fill(32767);
  const first = bfsDistances(grid, spawns[0]);
  for (let i = 0; i < TOTAL; i++) if (first[i] >= 0) min[i] = first[i];
  for (let k = 1; k < 4; k++) {
    let best = -1, bestV = -1;
    for (let i = 0; i < TOTAL; i++) {
      if (grid[i] !== 0 || min[i] === 32767) continue;
      if (spawns.indexOf(i) !== -1) continue;
      if (min[i] > bestV) { bestV = min[i]; best = i; }
    }
    if (best < 0) break;
    spawns.push(best);
    const d = bfsDistances(grid, best);
    for (let i = 0; i < TOTAL; i++) if (d[i] >= 0 && d[i] < min[i]) min[i] = d[i];
  }
  return spawns;
}

function chooseKeyRooms(grid, deadEnds, spawnMin, rng) {
  const pool = deadEnds.filter(i => spawnMin[i] >= CFG.KEY_MIN_SPAWN);
  shuffle(pool, rng);
  const want = clamp(Math.round(deadEnds.length * CFG.KEY_RATIO), CFG.KEY_MIN, CFG.KEY_MAX);
  const chosen = [];
  const cache = new Map();
  for (let k = 0; k < pool.length && chosen.length < want; k++) {
    const cand = pool[k];
    let ok = true;
    for (let j = 0; j < chosen.length; j++) {
      let d = cache.get(chosen[j]);
      if (!d) { d = bfsDistances(grid, chosen[j]); cache.set(chosen[j], d); }
      if (d[cand] < CFG.KEY_MIN_GAP) { ok = false; break; }
    }
    if (ok) chosen.push(cand);
  }
  // 放不满时逐档放宽间隔，保证钥匙数量仍随死胡同数生成
  for (let gap = CFG.KEY_MIN_GAP - 2; gap >= 4 && chosen.length < want; gap -= 2) {
    for (let k = 0; k < pool.length && chosen.length < want; k++) {
      const cand = pool[k];
      if (chosen.indexOf(cand) !== -1) continue;
      let ok = true;
      for (let j = 0; j < chosen.length; j++) {
        let d = cache.get(chosen[j]);
        if (!d) { d = bfsDistances(grid, chosen[j]); cache.set(chosen[j], d); }
        if (d[cand] < gap) { ok = false; break; }
      }
      if (ok) chosen.push(cand);
    }
  }
  return chosen;
}

/** Braid：非钥匙死胡同按概率打通一面墙，形成可甩怪的环路 */
function braid(grid, deadEnds, keyRooms, rng) {
  const protectedSet = new Set(keyRooms);
  for (let k = 0; k < deadEnds.length; k++) {
    const i = deadEnds[k];
    if (protectedSet.has(i) || rng() >= CFG.BRAID_RATE) continue;
    const x = xOf(i), y = yOf(i);
    const cands = [];
    for (let d = 0; d < 4; d++) {
      const wx = x + DIRS[d][0], wy = y + DIRS[d][1];
      const fx = x + DIRS[d][0] * 2, fy = y + DIRS[d][1] * 2;
      if (!inBounds(wx, wy) || !inBounds(fx, fy)) continue;
      if (fx <= 0 || fx >= N - 1 || fy <= 0 || fy >= N - 1) continue;
      if (grid[idx(wx, wy)] === 1 && grid[idx(fx, fy)] === 0) cands.push(idx(wx, wy));
    }
    if (cands.length) grid[cands[Math.floor(rng() * cands.length)]] = 0;
  }
}

function pickExit(grid, keyRooms, spawnMin, minSpawnDist) {
  const keyDists = keyRooms.map(i => bfsDistances(grid, i));
  let best = -1, bestV = Infinity;
  for (let i = 0; i < TOTAL; i++) {
    if (grid[i] !== 0 || spawnMin[i] < minSpawnDist) continue;
    let worst = 0;
    for (let k = 0; k < keyDists.length; k++) {
      const d = keyDists[k][i];
      if (d < 0) { worst = Infinity; break; }
      if (d > worst) worst = d;
    }
    if (worst < bestV) { bestV = worst; best = i; }
  }
  return { exitI: best, worstKey: bestV, keyDists };
}

function pickMonsterHome(grid, exitI, spawnMin) {
  const d = bfsDistances(grid, exitI);
  let best = -1, bestV = -1;
  for (let i = 0; i < TOTAL; i++) {
    if (grid[i] !== 0 || d[i] < 0 || d[i] > CFG.MONSTER_HOME_R) continue;
    if (spawnMin[i] < CFG.MONSTER_MIN_SPAWN) continue;
    if (spawnMin[i] > bestV) { bestV = spawnMin[i]; best = i; }
  }
  if (best >= 0) return best;
  // 放宽：允许环带内任意格，仍优先离出生点远的
  for (let i = 0; i < TOTAL; i++) {
    if (grid[i] !== 0 || d[i] < 0 || d[i] > CFG.MONSTER_HOME_R) continue;
    if (spawnMin[i] > bestV) { bestV = spawnMin[i]; best = i; }
  }
  return best >= 0 ? best : exitI;
}

/* ---------- 位打包 / 哈希（不依赖全局 btoa，浏览器与 Node 均可） ---------- */
const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function packGrid(grid) {
  const bytes = new Uint8Array(Math.ceil(TOTAL / 8));
  for (let i = 0; i < TOTAL; i++) if (grid[i]) bytes[i >> 3] |= (1 << (i & 7));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64CHARS[a >> 2];
    out += B64CHARS[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64CHARS[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64CHARS[c & 63] : '=';
  }
  return out;
}

export function unpackGrid(b64) {
  const bytes = new Uint8Array(Math.ceil(TOTAL / 8));
  const lookup = {};
  for (let i = 0; i < B64CHARS.length; i++) lookup[B64CHARS[i]] = i;
  for (let i = 0, p = 0; i < b64.length; i += 4, p += 3) {
    const a = lookup[b64[i]] || 0;
    const b = lookup[b64[i + 1]] || 0;
    const c = b64[i + 2] === '=' ? 0 : (lookup[b64[i + 2]] || 0);
    const d = b64[i + 3] === '=' ? 0 : (lookup[b64[i + 3]] || 0);
    if (p < bytes.length) bytes[p] = (a << 2) | (b >> 4);
    if (p + 1 < bytes.length) bytes[p + 1] = ((b & 15) << 4) | (c >> 2);
    if (p + 2 < bytes.length) bytes[p + 2] = ((c & 3) << 6) | d;
  }
  const grid = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) grid[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return grid;
}

export function hashGrid(grid) {
  let h = 0x811c9dc5;
  for (let i = 0; i < TOTAL; i++) {
    h ^= grid[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 生成一局完整地图；返回对象含 host 专用的真假标记（广播前须用 publicMapInfo 脱敏） */
export function generateMap(seed) {
  const rng = makeRng(seed);
  for (let attempt = 0; attempt < CFG.MAX_RETRY; attempt++) {
    const grid = new Uint8Array(TOTAL);
    carveMaze(grid, rng);
    const deadEnds = collectDeadEnds(grid);
    const spawns = pickSpawns(grid);
    const spawnMin = spawnMinDistances(grid, spawns);

    // 出生点两两间距
    let spawnOk = true;
    for (let a = 0; a < spawns.length && spawnOk; a++) {
      const d = bfsDistances(grid, spawns[a]);
      for (let b = a + 1; b < spawns.length; b++) {
        if (d[spawns[b]] < CFG.SPAWN_MIN_GAP) { spawnOk = false; break; }
      }
    }
    if (!spawnOk || spawns.length < 4) continue;

    const keyRooms = chooseKeyRooms(grid, deadEnds, spawnMin, rng);
    if (keyRooms.length < CFG.KEY_MIN) continue;

    braid(grid, deadEnds, keyRooms, rng);

    // 真假分配：假钥匙不计通关进度
    const fakeCount = clamp(Math.round(keyRooms.length * CFG.FAKE_RATE), CFG.FAKE_MIN, CFG.FAKE_MAX);
    const order = shuffle(keyRooms.slice(), rng);
    const fakeSet = new Set(order.slice(0, fakeCount));
    const keys = keyRooms.map(i => ({ i, real: !fakeSet.has(i) }));
    const realKeys = keys.filter(k => k.real).map(k => k.i);

    const minSpawnDist = attempt < 15 ? CFG.EXIT_MIN_DIST : (attempt < 25 ? 18 : 15);
    const ex = pickExit(grid, keyRooms, spawnMin, minSpawnDist);
    if (ex.exitI < 0 || ex.worstKey > CFG.EXIT_KEY_MAX) continue;

    // 钥匙 / 终点在 braid 之后仍可达
    const reach = bfsDistances(grid, spawns[0]);
    let reachable = true;
    for (let k = 0; k < keyRooms.length; k++) if (reach[keyRooms[k]] < 0) { reachable = false; break; }
    if (!reachable || reach[ex.exitI] < 0) continue;

    const monsterHomeI = pickMonsterHome(grid, ex.exitI, spawnMin);
    if (monsterHomeI < 0 || spawnMin[monsterHomeI] < CFG.MONSTER_MIN_SPAWN) continue;

    return {
      seed, grid, deadEndCount: deadEnds.length,
      keys, realTotal: realKeys.length, fakeTotal: fakeCount,
      fakeIds: keys.map((k, n) => k.real ? -1 : n).filter(n => n >= 0),
      keyIds: keys.map(k => k.i),
      realKeyIds: realKeys,
      spawns: spawns.map(i => ({ x: xOf(i), y: yOf(i) })),
      spawnIs: spawns,
      exitI: ex.exitI,
      monsterHomeI,
      mapB64: packGrid(grid),
      mapHash: hashGrid(grid)
    };
  }
  // 极端兜底：返回最后一次可玩的图（放宽所有距离约束）
  const grid = new Uint8Array(TOTAL);
  carveMaze(grid, rng);
  const deadEnds = collectDeadEnds(grid);
  const spawns = pickSpawns(grid);
  const spawnMin = spawnMinDistances(grid, spawns);
  const keyRooms = chooseKeyRooms(grid, deadEnds, spawnMin, rng);
  braid(grid, deadEnds, keyRooms, rng);
  const fakeCount = clamp(Math.round(keyRooms.length * CFG.FAKE_RATE), CFG.FAKE_MIN, CFG.FAKE_MAX);
  const order = shuffle(keyRooms.slice(), rng);
  const fakeSet = new Set(order.slice(0, fakeCount));
  const keys = keyRooms.map(i => ({ i, real: !fakeSet.has(i) }));
  const ex = pickExit(grid, keyRooms, spawnMin, 10);
  const exitI = ex.exitI >= 0 ? ex.exitI : keyRooms[0];
  return {
    seed, grid, deadEndCount: deadEnds.length,
    keys, realTotal: keys.filter(k => k.real).length, fakeTotal: fakeCount,
    fakeIds: keys.map((k, n) => k.real ? -1 : n).filter(n => n >= 0),
    keyIds: keys.map(k => k.i),
    realKeyIds: keys.filter(k => k.real).map(k => k.i),
    spawns: spawns.map(i => ({ x: xOf(i), y: yOf(i) })),
    spawnIs: spawns,
    exitI,
    monsterHomeI: pickMonsterHome(grid, exitI, spawnMin),
    mapB64: packGrid(grid),
    mapHash: hashGrid(grid)
  };
}

/** 脱敏：广播给全员的信息里绝不含真假标记 */
export function publicMapInfo(m) {
  return {
    size: N,
    mapB64: m.mapB64,
    mapHash: m.mapHash,
    keys: m.keyIds.slice(),
    realTotal: m.realTotal,
    fakeTotal: m.fakeTotal,
    exitI: m.exitI,
    monsterHomeI: m.monsterHomeI,
    spawns: m.spawns.map(s => ({ x: s.x, y: s.y }))
  };
}

/** 校验各端解包后的地图一致性 */
export function verifyMap(info) {
  const grid = unpackGrid(info.mapB64);
  return hashGrid(grid) === info.mapHash;
}
