/* ============================================================
   合作逃生 · Canvas 绘制
   底图（离屏整图）→ 雾层（离屏）→ 实体（只查 lit）→ 能力叠加层 / 箭头
   ============================================================ */

import { N, idx, xOf, yOf } from './escape-map.js?v=20261113r';
import { VIEW, MAP_PAD, drawFog, projectEdge } from './escape-fog.js?v=20261113r';

export const COLORS = {
  WALL: '#8f1d2c',
  WALL_EDGE: '#c0392b',
  FLOOR: '#39424c',
  EXIT_OFF: '#5a1018',
  EXIT_ON: '#ff3b3b',
  EXIT_GOLD: '#ffd45a',
  KEY: '#ffd45a',
  FAKE_GLOW: 'rgba(255,0,170,0.55)',
  FAKE_RING: '#ff2020',
  MONSTER: '#2b0710',
  MONSTER_EYE: '#ffd45a',
  BEACON: '#fff1c9',
  CORPSE: '#9a8b8e'
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const mapCanvas = document.createElement('canvas');
  const mapCtx = mapCanvas.getContext('2d');
  const fogCanvas = document.createElement('canvas');
  const fogCtx = fogCanvas.getContext('2d');
  let cell = 24, s = 360, mapKey = '';

  function resize(size) {
    s = Math.max(120, Math.round(size));
    cell = s / VIEW;
    canvas.width = s; canvas.height = s;
    fogCanvas.width = s; fogCanvas.height = s;
    const ms = Math.ceil((N + MAP_PAD * 2) * cell);
    mapCanvas.width = ms; mapCanvas.height = ms;
    mapKey = '';
  }

  function paintMap(grid) {
    const ms = mapCanvas.width;
    const off = MAP_PAD * cell;
    mapCtx.fillStyle = '#0a0406';
    mapCtx.fillRect(0, 0, ms, ms);
    mapCtx.fillStyle = COLORS.FLOOR;
    mapCtx.fillRect(off, off, Math.ceil(N * cell), Math.ceil(N * cell));
    mapCtx.fillStyle = COLORS.WALL;
    for (let i = 0; i < N * N; i++) {
      if (!grid[i]) continue;
      mapCtx.fillRect(off + xOf(i) * cell, off + yOf(i) * cell, cell + 0.6, cell + 0.6);
    }
    // 墙顶高光，让红色墙体在地板上更清晰
    mapCtx.strokeStyle = COLORS.WALL_EDGE;
    mapCtx.lineWidth = Math.max(1, cell * 0.06);
    mapCtx.globalAlpha = 0.45;
    for (let i = 0; i < N * N; i++) {
      if (!grid[i]) continue;
      const x = off + xOf(i) * cell, y = off + yOf(i) * cell;
      mapCtx.beginPath();
      mapCtx.moveTo(x, y + cell * 0.12);
      mapCtx.lineTo(x + cell, y + cell * 0.12);
      mapCtx.stroke();
    }
    mapCtx.globalAlpha = 1;
  }

  function sx(wx) { return (wx - st.camX) * cell; }
  function sy(wy) { return (wy - st.camY) * cell; }
  let st = null;

  function keyShape(cx, cy, r, fake, known, pulse) {
    ctx.save();
    ctx.translate(cx, cy);
    if (fake) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cell * 0.95);
      g.addColorStop(0, COLORS.FAKE_GLOW);
      g.addColorStop(1, 'rgba(138,0,255,0)');
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      ctx.fillRect(-cell, -cell, cell * 2, cell * 2);
      ctx.globalAlpha = 1;
    } else {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cell * 0.8);
      g.addColorStop(0, 'rgba(255,212,90,0.42)');
      g.addColorStop(1, 'rgba(255,212,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-cell, -cell, cell * 2, cell * 2);
    }
    ctx.fillStyle = fake ? '#ff77dd' : COLORS.KEY;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-r * 0.18, 0, r * 0.36, r * 1.05);
    ctx.fillRect(r * 0.1, r * 0.55, r * 0.42, r * 0.2);
    if (fake) {
      // 骷髅标记：与主题红区分的第二重编码
      ctx.fillStyle = '#2b0710';
      ctx.beginPath(); ctx.arc(-r * 0.24, -r * 0.12, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.24, -r * 0.12, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-r * 0.2, r * 0.18, r * 0.4, r * 0.12);
    }
    if (known && fake) {
      // 能力②：高饱和硬红边框，在满屏红里仍能一眼分辨
      ctx.strokeStyle = COLORS.FAKE_RING;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.globalAlpha = 0.65 + 0.35 * pulse;
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function arrow(gx, gy, angle, color, scale) {
    const x = gx * cell, y = gy * cell, r = cell * (scale || 0.42);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.7, -r * 0.7);
    ctx.lineTo(-r * 0.35, 0);
    ctx.lineTo(-r * 0.7, r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function draw(data) {
    st = data;
    if (!data.grid || !data.sight) return;
    if (mapKey !== data.mapHash) { paintMap(data.grid); mapKey = data.mapHash; }

    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(mapCanvas, (data.camX + MAP_PAD) * cell, (data.camY + MAP_PAD) * cell,
      VIEW * cell, VIEW * cell, 0, 0, s, s);

    drawFog(fogCtx, data.sight, data.camX, data.camY, cell, {
      revealAll: !!data.revealAll,
      px: data.px, py: data.py
    });
    ctx.drawImage(fogCanvas, 0, 0);

    const pulse = 0.5 + 0.5 * Math.sin(data.now / 260);
    const lit = data.sight.lit;
    const inView = (wx, wy) => wx >= data.camX && wx < data.camX + VIEW && wy >= data.camY && wy < data.camY + VIEW;

    // ---- 终点（只在照亮时可见） ----
    const ex = xOf(data.exitI), ey = yOf(data.exitI);
    if (lit[data.exitI] && inView(ex, ey)) {
      ctx.fillStyle = data.exitActive ? COLORS.EXIT_ON : COLORS.EXIT_OFF;
      ctx.fillRect(sx(ex) + cell * 0.08, sy(ey) + cell * 0.08, cell * 0.84, cell * 0.84);
      if (data.exitActive) {
        ctx.strokeStyle = COLORS.EXIT_GOLD;
        ctx.lineWidth = Math.max(2, cell * 0.1);
        ctx.globalAlpha = 0.55 + 0.45 * pulse;
        ctx.strokeRect(sx(ex) + cell * 0.1, sy(ey) + cell * 0.1, cell * 0.8, cell * 0.8);
        ctx.globalAlpha = 1;
      }
    }

    // ---- 钥匙（只在照亮时画实体；透视能力单独画标记层） ----
    for (let k = 0; k < data.keys.length; k++) {
      const key = data.keys[k];
      if (key.taken) continue;
      const kx = xOf(key.i), ky = yOf(key.i);
      if (!lit[key.i] || !inView(kx, ky)) continue;
      const isFake = data.fakeIds.indexOf(k) !== -1;
      keyShape(sx(kx) + cell / 2, sy(ky) + cell / 2, cell * 0.32, isFake, !!data.distinguish && isFake, pulse);
    }

    // ---- 怪物（只在照亮时可见） ----
    if (data.monster && lit[idx(data.monster.x, data.monster.y)] && inView(data.monster.x, data.monster.y)) {
      const mx = sx(data.monster.x) + cell / 2, my = sy(data.monster.y) + cell / 2;
      // 僵直：撞完人自己「喘气」——缩小、红晕收敛、头顶转圈的小点，玩家一眼就知道该跑了
      const stunned = data.monster.st === 'stun';
      const r = cell * (stunned ? 0.3 : 0.4);
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, r * 1.6);
      g.addColorStop(0, stunned ? 'rgba(255,150,90,0.4)' : 'rgba(255,60,60,0.55)');
      g.addColorStop(1, 'rgba(255,60,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(mx - r * 1.6, my - r * 1.6, r * 3.2, r * 3.2);
      ctx.fillStyle = COLORS.MONSTER;
      ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = stunned ? 'rgba(255,212,90,0.7)' : COLORS.MONSTER_EYE;
      ctx.beginPath(); ctx.arc(mx - r * 0.35, my - r * 0.1, r * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(mx + r * 0.35, my - r * 0.1, r * 0.16, 0, Math.PI * 2); ctx.fill();
      if (stunned) {
        // 头顶三颗转圈的「眩晕星」
        ctx.fillStyle = 'rgba(255,212,90,0.95)';
        for (let s = 0; s < 3; s++) {
          const a = (data.now / 700) * Math.PI * 2 + s * (Math.PI * 2 / 3);
          ctx.beginPath();
          ctx.arc(mx + Math.cos(a) * cell * 0.34, my + Math.sin(a) * cell * 0.34 - cell * 0.18,
            Math.max(1.4, cell * 0.06), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ---- 玩家 / 尸体 ----
    for (let k = 0; k < data.players.length; k++) {
      const p = data.players[k];
      const pi = idx(p.x, p.y);
      const isSelf = p.id === data.viewId;
      const teammateReveal = data.allyUnlocked && !isSelf;
      if (!lit[pi] && !teammateReveal) continue;
      if (!inView(p.x, p.y)) continue;
      const px = sx(p.x), py = sy(p.y);
      if (!p.alive) {
        ctx.strokeStyle = COLORS.CORPSE;
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.beginPath();
        ctx.moveTo(px + cell * 0.28, py + cell * 0.28);
        ctx.lineTo(px + cell * 0.72, py + cell * 0.72);
        ctx.moveTo(px + cell * 0.72, py + cell * 0.28);
        ctx.lineTo(px + cell * 0.28, py + cell * 0.72);
        ctx.stroke();
        continue;
      }
      if (teammateReveal && !lit[pi]) {
        ctx.globalAlpha = 0.72;
      }
      ctx.fillStyle = p.color || '#ffffff';
      ctx.fillRect(px + cell * 0.16, py + cell * 0.16, cell * 0.68, cell * 0.68);
      if (p.bot) {
        // 人机：方格里两只深色「眼睛」，和真人方块一眼区分
        ctx.fillStyle = 'rgba(10,4,6,0.72)';
        ctx.fillRect(px + cell * 0.3, py + cell * 0.4, cell * 0.12, cell * 0.12);
        ctx.fillRect(px + cell * 0.58, py + cell * 0.4, cell * 0.12, cell * 0.12);
      }
      ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(0,0,0,0.65)';
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.strokeRect(px + cell * 0.16, py + cell * 0.16, cell * 0.68, cell * 0.68);
      ctx.globalAlpha = 1;
    }

    // ---- 能力①：钥匙位置透视（雾上标记 + 画面外箭头） ----
    if (data.keyBeacons) {
      for (let k = 0; k < data.keys.length; k++) {
        const key = data.keys[k];
        if (key.taken) continue;
        const kx = xOf(key.i), ky = yOf(key.i);
        if (inView(kx, ky)) {
          ctx.fillStyle = COLORS.BEACON;
          ctx.globalAlpha = 0.7;
          ctx.beginPath(); ctx.arc(sx(kx) + cell / 2, sy(ky) + cell / 2, cell * 0.14, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          const e = projectEdge(kx, ky, data.camX, data.camY);
          if (e) arrow(e.gx, e.gy, e.angle, COLORS.BEACON, 0.3);
        }
      }
    }

    // ---- 队友位置显示：全队解锁后透视迷雾，画面外用同色箭头 ----
    if (data.allyUnlocked) {
      for (let k = 0; k < data.players.length; k++) {
        const p = data.players[k];
        if (p.id === data.viewId || !p.alive) continue;
        if (!inView(p.x, p.y)) {
          const e = projectEdge(p.x, p.y, data.camX, data.camY);
          if (e) arrow(e.gx, e.gy, e.angle, p.color || '#ffffff', 0.42);
        } else if (!lit[idx(p.x, p.y)]) {
          ctx.fillStyle = p.color || '#ffffff';
          ctx.globalAlpha = 0.55;
          ctx.beginPath(); ctx.arc(sx(p.x) + cell / 2, sy(p.y) + cell / 2, cell * 0.2, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }

    // ---- 终点激活后给方向箭头 ----
    if (data.exitActive && !inView(ex, ey)) {
      const e = projectEdge(ex, ey, data.camX, data.camY);
      if (e) arrow(e.gx, e.gy, e.angle, COLORS.EXIT_GOLD, 0.5);
    }
  }

  return { resize, draw, get cell() { return cell; }, get size() { return s; } };
}
