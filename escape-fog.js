/* ============================================================
   合作逃生 · 视野与迷雾（纯函数，无 DOM 依赖，但需要 2D context 画雾）
   十字射线 4 格 + 沿通路格把视线扩散到半径 4（近似固定圆形光圈，仍不穿墙）
   lit 是唯一显隐真源；任何能力都不许往 lit 里塞格子

   【固定视野范围 / 防闪烁】两套东西严格分开：
   ① computeSight().lit —— 逻辑真源：实体显隐、怪物感知、心跳音效全认它，
      带墙体遮挡，**一行都不许改**（改了怪物就会穿墙看见人）。
   ② 渲染用的「固定渐晕 + 遮挡黑幕」—— 只决定画面明暗，不影响任何判定：
      · 渐晕表按屏幕坐标算一次，玩家恒定居中 ⇒ 移动时光圈轮廓完全不变；
      · 墙后 / 射线外的格子（lit=0）盖成不透明黑，玩家看不到墙后地板；
      · 每格浓度逐帧趋近目标，亮↔黑走渐变而不是硬切。
   ============================================================ */

import { N, idx, xOf, yOf, inBounds, clamp } from './escape-map.js?v=20261114e';

export const FOG_SIGHT = 4;      // 玩家四个正交方向各看 4 格
// 视线从十字射线沿通路格扩散到整个半径 4：视野形状接近固定的圆形光圈，
// 走过路口时不再「十字臂忽长忽短」。扩散只在通路格继续，墙本身可见但光不穿墙。
// 注意：怪物 AI 调用 computeSight 时显式传 peek=1（窄十字），不受这里影响。
export const FOG_PEEK = 4;
// 摄像机窗口（奇数，玩家恒定居中）。只比「视野半径 4」的外圈多 1 格，
// 画面几乎被可见区填满，不再留一大圈用不上的黑边；渐晕仍能完整收束到纯黑。
export const VIEW = 11;

// 底图四周留白：覆盖 camX/camY 贴边时的负坐标即可，别写死 15 ——
// VIEW 变小后 cell 变大，留白过大会把离屏底图撑到几十 MB。
export const MAP_PAD = (VIEW >> 1) + 2;
// 只比玩家多看 1 格：原来 8 格是玩家的两倍，怪物永远先发现人，
// 单格走廊里玩家跑出 4 格仍被锁定，拐弯也断不了线。
export const MONSTER_SIGHT = 5;

export const VISION_R = FOG_SIGHT;   // 固定光圈半径（格），与玩家坐标无关
export const FOG_FADE_MS = 140;      // 黑幕浓度淡入淡出时长（消除明暗硬切）
export const FOG_SOLID = 1;          // 墙后 / 视野外：不透明黑

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * 计算以 (px,py) 为中心的可见格集合。
 * 返回 { lit: Uint8Array, dist: Uint8Array, rim: number[], litList: number[] }
 * dist = 距离玩家的深度（1..sight），rim = 视野尽头一格（dist === sight）
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

  // 从直线上的通路格向外逐层带光，把视野铺满半径 sight：
  // 玩家看到的是一块近似圆形的地形，而不是忽长忽短的十字。
  // 只有通路格能继续带光，所以墙后依旧是黑的。
  let frontier = spine.filter(s => s.d < sight);
  for (let p = 1; p <= peek && frontier.length; p++) {
    const next = [];
    for (let s = 0; s < frontier.length; s++) {
      // 每轮只往外走一层：frontier[s].d 已经含了之前所有轮次，
      // 再 +p 会重复累加轮数，peek>1 时等于没生效（老代码只用过 peek=1）。
      const fi = frontier[s].i, fd = frontier[s].d + 1;
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
 * 屏幕空间的固定渐晕表（0 = 全亮，1 = 不透明黑）。
 * 玩家恒定居中，所以这张表**与玩家坐标、地图、时间全都无关**，只算一次。
 * 移动时它一格都不变，变化的只有从底下滚过去的地图 —— 这就是「固定视野范围」。
 */
export function buildVisionMask() {
  const m = new Float32Array(VIEW * VIEW);
  const c = (VIEW - 1) / 2;
  for (let vy = 0; vy < VIEW; vy++) {
    for (let vx = 0; vx < VIEW; vx++) {
      const dx = vx - c, dy = vy - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      // 半径内全亮，最后约 1.4 格柔和过渡到不透明黑（smoothstep，无硬边）
      const t = clamp((d - (VISION_R - 0.7)) / 1.4, 0, 1);
      m[vy * VIEW + vx] = t * t * (3 - 2 * t);
    }
  }
  return m;
}

/**
 * 每格黑幕浓度的目标值。只认 sight.lit：墙后 / 射线外的格子一律盖成
 * 不透明黑，玩家看不到墙后地板；亮格则取固定渐晕的浓度。
 */
export function fogTargets(mask, sight, camX, camY) {
  const out = new Float32Array(VIEW * VIEW);
  for (let vy = 0; vy < VIEW; vy++) {
    for (let vx = 0; vx < VIEW; vx++) {
      const k = vy * VIEW + vx;
      const wx = camX + vx, wy = camY + vy;
      if (wx < 0 || wx >= N || wy < 0 || wy >= N) { out[k] = FOG_SOLID; continue; } // 图外留纯黑
      if (sight.lit[wy * N + wx]) out[k] = mask[k];
      else out[k] = FOG_SOLID;
    }
  }
  return out;
}

/** 逐帧把当前浓度推向目标：亮↔黑走 140ms 渐变，移动时不再整片硬切 */
export function approachFog(cur, target, dtMs) {
  const step = Math.min(1, Math.max(0, dtMs) / FOG_FADE_MS);
  if (step <= 0) return cur;
  for (let k = 0; k < cur.length; k++) {
    const d = target[k] - cur[k];
    if (d > 0) cur[k] = Math.min(target[k], cur[k] + step);
    else if (d < 0) cur[k] = Math.max(target[k], cur[k] - step);
  }
  return cur;
}

/**
 * 在专用雾层 canvas 上画雾。alpha 是 approachFog 平滑后的每格黑幕浓度（0..1）。
 * 逐格略重叠 0.6px，避免相邻黑格之间露出亮缝。
 */
export function drawFog(fogCtx, alpha, cell) {
  const s = VIEW * cell;
  fogCtx.clearRect(0, 0, s, s);
  for (let vy = 0; vy < VIEW; vy++) {
    for (let vx = 0; vx < VIEW; vx++) {
      const a = alpha[vy * VIEW + vx];
      if (a <= 0.001) continue;
      fogCtx.fillStyle = a >= 0.999 ? '#000000' : 'rgba(0,0,0,' + a.toFixed(3) + ')';
      fogCtx.fillRect(vx * cell, vy * cell, cell + 0.6, cell + 0.6);
    }
  }
}
