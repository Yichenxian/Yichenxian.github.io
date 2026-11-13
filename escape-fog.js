/* ============================================================
   合作逃生 · 视野与迷雾（纯函数，无 DOM 依赖，但需要 2D context 画雾）
   十字射线 4 格 + 走廊格四邻探头 1 格（拐角后一格）
   lit 是唯一显隐真源；任何能力都不许往 lit 里塞格子
   ============================================================ */

import { N, idx, xOf, yOf, inBounds, clamp } from './escape-map.js?v=20261113l';

// 底图在四周各留 VIEW 格空白，摄像机才可以把玩家恒定放在窗口正中
export const MAP_PAD = 15;

export const FOG_SIGHT = 4;      // 玩家四个正交方向各看 4 格
export const FOG_PEEK = 1;       // 拐角后一格
export const VIEW = 15;          // 摄像机窗口 15×15 格
export const MONSTER_SIGHT = 8;  // 怪物视野 = 玩家两倍

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * 计算以 (px,py) 为中心的可见格集合。
 * 返回 { lit: Uint8Array, dist: Uint8Array, rim: number[], litList: number[] }
 * dist = 距离玩家的深度（1..sight），rim = 视野尽头一圈（dist === sight）
 */
export function computeSight(grid, px, py, sight = FOG_SIGHT, peek = FOG_PEEK) {
  const lit = new Uint8Array(N * N);
  const dist = new Uint8Array(N * N);
  const spine = [];
  const start = idx(px, py);
  lit[start] = 1;
  dist[start] = 0;

  for (let d = 0; d < 4; d++) {
    for (let k = 1; k <= sight; k++) {
      const x = px + DIRS[d][0] * k, y = py + DIRS[d][1] * k;
      if (!inBounds(x, y)) break;
      const ni = idx(x, y);
      if (!lit[ni] || k < dist[ni]) { lit[ni] = 1; dist[ni] = k; }
      if (grid[ni] === 1) break;      // 墙本身可见，但光不穿墙
      spine.push({ i: ni, d: k });
    }
  }

  // 从直线上的通路格向四邻探头：看到岔路侧格 / 拐角后一格
  let frontier = spine.filter(s => s.d < sight);
  for (let p = 1; p <= peek && frontier.length; p++) {
    const next = [];
    for (let s = 0; s < frontier.length; s++) {
      const fi = frontier[s].i, fd = frontier[s].d + p;
      if (fd > sight) continue;
      const fx = xOf(fi), fy = yOf(fi);
      for (let d = 0; d < 4; d++) {
        const nx = fx + DIRS[d][0], ny = fy + DIRS[d][1];
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!lit[ni] || fd < dist[ni]) { lit[ni] = 1; dist[ni] = fd; }
        // 只有通路格能继续带光；墙那一侧永远是黑的
        if (grid[ni] === 0 && next.indexOf(ni) === -1) next.push({ i: ni, d: fd });
      }
    }
    frontier = next.filter(s => s.d < sight);
  }

  const litList = [], rim = [];
  for (let i = 0; i < N * N; i++) {
    if (!lit[i]) continue;
    litList.push(i);
    if (dist[i] === sight) rim.push(i);
  }
  return { lit, dist, rim, litList };
}

export function entityVisible(sight, i) { return !!sight.lit[i]; }

/** 摄像机以玩家为恒定中心；边缘处允许负坐标，由底图留白补齐纯黑 */
export function centerCam(px, py) {
  const half = VIEW >> 1;
  return { camX: px - half, camY: py - half };
}

/** 画面外目标的边缘箭头投影；返回 null 表示目标在画面内 */
export function projectEdge(tx, ty, camX, camY) {
  const vx = tx - camX + 0.5, vy = ty - camY + 0.5;
  if (vx >= 0 && vx <= VIEW && vy >= 0 && vy <= VIEW) return null;
  const cx = VIEW / 2, cy = VIEW / 2, pad = 1.3;
  const dx = vx - cx, dy = vy - cy;
  const txEdge = Math.abs(dx) > 1e-6 ? (cx - pad) / Math.abs(dx) : Infinity;
  const tyEdge = Math.abs(dy) > 1e-6 ? (cy - pad) / Math.abs(dy) : Infinity;
  const t = Math.min(txEdge, tyEdge);
  return {
    gx: clamp(cx + dx * t, pad, VIEW - pad),
    gy: clamp(cy + dy * t, pad, VIEW - pad),
    angle: Math.atan2(dy, dx)
  };
}

/**
 * 在专用雾层 canvas 上绘制迷雾。
 * fogCtx 必须是离屏 canvas 的 context（clearRect 不会擦掉主画布底图）。
 * opts: { revealAll:boolean, px:number, py:number }
 */
export function drawFog(fogCtx, sight, camX, camY, cell, opts) {
  const s = VIEW * cell;
  const revealAll = !!opts.revealAll;
  const outerAlpha = revealAll ? 0.72 : 0.85;
  fogCtx.clearRect(0, 0, s, s);
  fogCtx.fillStyle = revealAll ? 'rgba(0,0,0,0.72)' : '#000000';
  fogCtx.fillRect(0, 0, s, s);

  const px = opts.px, py = opts.py;
  for (let vy = 0; vy < VIEW; vy++) {
    for (let vx = 0; vx < VIEW; vx++) {
      const wx = camX + vx, wy = camY + vy;
      if (wx < 0 || wx >= N || wy < 0 || wy >= N) continue;  // 图外留纯黑
      const i = wy * N + wx;
      if (!sight.lit[i]) continue;
      const x = vx * cell, y = vy * cell;
      if (sight.dist[i] < FOG_SIGHT) {
        fogCtx.clearRect(x, y, cell, cell);
        continue;
      }
      // 视野尽头一格：沿「远离玩家」方向画透明黑渐变
      fogCtx.clearRect(x, y, cell, cell);
      const dx = wx - px, dy = wy - py;
      let x0, y0, x1, y1;
      if (Math.abs(dx) >= Math.abs(dy)) {
        const sign = dx >= 0 ? 1 : -1;
        x0 = sign > 0 ? x : x + cell;
        x1 = sign > 0 ? x + cell : x;
        y0 = y + cell / 2; y1 = y + cell / 2;
      } else {
        const sign = dy >= 0 ? 1 : -1;
        x0 = x + cell / 2; x1 = x + cell / 2;
        y0 = sign > 0 ? y : y + cell;
        y1 = sign > 0 ? y + cell : y;
      }
      const g = fogCtx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + outerAlpha + ')');
      fogCtx.fillStyle = g;
      fogCtx.fillRect(x, y, cell, cell);
    }
  }
}
