/* ============================================================
   合作逃生 · 画面
   离屏底图（石板地面 + 立体砖墙 + 墙脚接触阴影）
   → 实体（只认 sight.lit）
   → 火把暖光（lighter）
   → 平滑雾层（低分辨率上采样，边缘是有机的圆，不是格子阶梯）
   → 暗角
   → 穿雾标记 / 画面外箭头（能力①③④）

   雾层压在实体之上：墙后的东西被黑幕一起盖住，格子亮起时自然浮现，
   不必给每个实体单独算透明度。
   ============================================================ */

import { N, idx, xOf, yOf } from './escape-map.js?v=20261122a';
import { VIEW, projectEdge, buildVisionMask, fogTargets, approachFog, FOG_FADE_MS }
  from './escape-fog.js?v=20261122a';

export const COLORS = {
  FLOOR_A: '#242b35',
  FLOOR_B: '#1f252e',
  FLOOR_EDGE: 'rgba(0,0,0,.28)',
  WALL_TOP: '#8e2733',
  WALL_MID: '#5d1521',
  WALL_LOW: '#370b14',
  WALL_HI: 'rgba(255,150,140,.20)',
  MORTAR: 'rgba(0,0,0,.30)',
  RIM: 'rgba(255,120,110,.55)',
  EXIT_OFF: '#3a0d16',
  EXIT_ON: '#ff4646',
  EXIT_GOLD: '#ffd45a',
  KEY: '#ffd45a',
  KEY_DARK: '#8d5c07',
  FAKE: '#ff5ce0',
  FAKE_DARK: '#8c008a',
  FAKE_RING: '#ff2d2d',
  MONSTER: '#18030e',
  MONSTER_EYE: '#ffd45a',
  BEACON: '#ffe6a8',
  CORPSE: '#8e7e83'
};

function hash01(i) {
  let h = (i * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex, k) {
  let h = String(hex || '#ffffff').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return hex;
  const r = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * k)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * k)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * k)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const mapCanvas = document.createElement('canvas');
  const mapCtx = mapCanvas.getContext('2d');
  const fogCanvas = document.createElement('canvas');
  const fogCtx = fogCanvas.getContext('2d');
  // 雾的低分辨率缓冲：一像素 = 一格，放大时靠双线性插值把格子糊成圆润的光圈
  const fogLow = document.createElement('canvas');
  fogLow.width = VIEW; fogLow.height = VIEW;
  const fogLowCtx = fogLow.getContext('2d');
  const fogImg = fogLowCtx.createImageData(VIEW, VIEW);

  let cell = 24, s = 360, dpr = 1, mapKey = '';
  let mapCamX = -999, mapCamY = -999;   // 视窗底图当前对准的相机格（变了才重画）
  let shx = 0, shy = 0, st = null;
  const visionMask = buildVisionMask();
  const fogAlpha = new Float32Array(VIEW * VIEW).fill(1);
  let fogAt = 0, fogMapKey = '';

  function resize(size) {
    s = Math.max(120, Math.round(size));
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    cell = s / VIEW;
    canvas.width = Math.round(s * dpr);
    canvas.height = Math.round(s * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fogCanvas.width = Math.round(s * dpr);
    fogCanvas.height = Math.round(s * dpr);
    fogCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 底图只开「当前视窗 + 四周各一格」那么大：100×100 的大图若整图离屏预画会爆到几百 MB
    // +2 格是墙脚阴影 / 南向描边要渗进相邻格，边缘那圈只作缓冲不直接显示
    mapCanvas.width = Math.round((VIEW + 2) * cell * dpr);
    mapCanvas.height = Math.round((VIEW + 2) * cell * dpr);
    mapKey = ''; mapCamX = -999; mapCamY = -999;
    fogAlpha.fill(1); fogAt = 0; fogMapKey = '';
  }

  /* ---------------- 底图（按视窗绘制，不整图离屏） ----------------
     100×100 的大图若整图离屏预画会到几百 MB，这里只画当前 VIEW×VIEW 视窗，
     四周各扩一格 —— 墙的描边要看邻格、南向接触阴影要压进下面那一格。 */
  function paintMap(grid, camX, camY) {
    const ms = mapCanvas.width / dpr;
    const W = VIEW + 2;
    const x0 = camX - 1, y0 = camY - 1;
    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mapCtx.clearRect(0, 0, ms, ms);
    mapCtx.fillStyle = '#05010a';
    mapCtx.fillRect(0, 0, ms, ms);

    const wall = (gx, gy) => (gx >= 0 && gx < N && gy >= 0 && gy < N) ? !!grid[gy * N + gx] : false;
    const cellX = wx => wx * cell;
    const cellY = wy => wy * cell;
    const inMap = (gx, gy) => gx >= 0 && gx < N && gy >= 0 && gy < N;

    // ---- 地面 ----
    for (let wy = 0; wy < W; wy++) {
      for (let wx = 0; wx < W; wx++) {
        const gx = x0 + wx, gy = y0 + wy;
        if (!inMap(gx, gy)) continue;
        const i = gy * N + gx;
        if (grid[i]) continue;
        const x = cellX(wx), y = cellY(wy);
        const h = hash01(i);
        mapCtx.fillStyle = h > 0.5 ? COLORS.FLOOR_A : COLORS.FLOOR_B;
        mapCtx.fillRect(x, y, cell + 0.7, cell + 0.7);
        // 石板内凹：上/左暗边 + 下/右亮边，一格就有厚度感
        mapCtx.strokeStyle = 'rgba(0,0,0,.22)';
        mapCtx.lineWidth = Math.max(1, cell * 0.035);
        mapCtx.beginPath();
        mapCtx.moveTo(x + 0.5, y + cell - 0.5);
        mapCtx.lineTo(x + 0.5, y + 0.5);
        mapCtx.lineTo(x + cell - 0.5, y + 0.5);
        mapCtx.stroke();
        mapCtx.strokeStyle = 'rgba(255,255,255,.035)';
        mapCtx.beginPath();
        mapCtx.moveTo(x + cell - 0.5, y + 0.5);
        mapCtx.lineTo(x + cell - 0.5, y + cell - 0.5);
        mapCtx.lineTo(x + 0.5, y + cell - 0.5);
        mapCtx.stroke();
        // 石屑
        if (h > 0.8) {
          const h2 = hash01(i + 7777);
          mapCtx.fillStyle = 'rgba(255,255,255,.055)';
          mapCtx.fillRect(x + cell * (0.18 + h * 0.55), y + cell * (0.18 + h2 * 0.55),
            Math.max(1, cell * 0.075), Math.max(1, cell * 0.075));
        }
        if (h < 0.12) {
          mapCtx.fillStyle = 'rgba(0,0,0,.20)';
          mapCtx.fillRect(x + cell * (0.2 + h * 3), y + cell * 0.62, Math.max(1, cell * 0.2), Math.max(1, cell * 0.05));
        }
      }
    }

    // ---- 墙体：整块砌体，只有真正露在外面的顶面才画亮面 ----
    for (let wy = 0; wy < W; wy++) {
      for (let wx = 0; wx < W; wx++) {
        const gx = x0 + wx, gy = y0 + wy;
        if (!inMap(gx, gy)) continue;
        const i = gy * N + gx;
        if (!grid[i]) continue;
        const x = cellX(wx), y = cellY(wy);
        const openTop = !wall(gx, gy - 1);
        const g = mapCtx.createLinearGradient(0, y, 0, y + cell);
        g.addColorStop(0, openTop ? COLORS.WALL_TOP : COLORS.WALL_MID);
        g.addColorStop(openTop ? 0.26 : 0.0, COLORS.WALL_MID);
        g.addColorStop(1, COLORS.WALL_LOW);
        mapCtx.fillStyle = g;
        mapCtx.fillRect(x, y, cell + 0.7, cell + 0.7);

        // 顶面高光：只在没有墙压着的那一侧，整片墙才有连续的脊线
        if (openTop) {
          mapCtx.fillStyle = COLORS.WALL_HI;
          mapCtx.fillRect(x, y + cell * 0.02, cell + 0.7, cell * 0.075);
        }

        // 砖缝：只画在顶面之下的主体区，按格错位
        const h = hash01(i);
        const top = y + cell * (openTop ? 0.3 : 0.08);
        mapCtx.strokeStyle = COLORS.MORTAR;
        mapCtx.lineWidth = Math.max(1, cell * 0.035);
        mapCtx.beginPath();
        const mid = y + cell * 0.62;
        mapCtx.moveTo(x, mid); mapCtx.lineTo(x + cell, mid);
        const sx0 = x + cell * (h > 0.5 ? 0.32 : 0.68);
        mapCtx.moveTo(sx0, top); mapCtx.lineTo(sx0, mid);
        const sx1 = x + cell * (h > 0.5 ? 0.72 : 0.28);
        mapCtx.moveTo(sx1, mid); mapCtx.lineTo(sx1, y + cell);
        mapCtx.stroke();
      }
    }

    // ---- 边缘：墙与地面交界处描暖色轮廓线 + 地面接触阴影 ----
    for (let wy = 0; wy < W; wy++) {
      for (let wx = 0; wx < W; wx++) {
        const gx = x0 + wx, gy = y0 + wy;
        if (!inMap(gx, gy)) continue;
        const i = gy * N + gx;
        if (!grid[i]) continue;
        const x = cellX(wx), y = cellY(wy);
        // 南侧（画面下方）是玩家视线主要接触的面，给最亮的边
        if (!wall(gx, gy + 1)) {
          mapCtx.fillStyle = COLORS.RIM;
          mapCtx.globalAlpha = 0.5;
          mapCtx.fillRect(x, y + cell - Math.max(1, cell * 0.045), cell + 0.7, Math.max(1, cell * 0.045));
          mapCtx.globalAlpha = 1;
          const sg = mapCtx.createLinearGradient(0, y + cell, 0, y + cell * 1.5);
          sg.addColorStop(0, 'rgba(0,0,0,.5)');
          sg.addColorStop(1, 'rgba(0,0,0,0)');
          mapCtx.fillStyle = sg;
          mapCtx.fillRect(x, y + cell, cell + 0.7, cell * 0.5);
        }
        if (!wall(gx, gy - 1)) { mapCtx.fillStyle = 'rgba(255,190,180,.10)'; mapCtx.fillRect(x, y, cell + 0.7, Math.max(1, cell * 0.04)); }
        if (!wall(gx - 1, gy)) { mapCtx.fillStyle = 'rgba(0,0,0,.30)'; mapCtx.fillRect(x, y, Math.max(1, cell * 0.05), cell + 0.7); }
        if (!wall(gx + 1, gy)) { mapCtx.fillStyle = 'rgba(255,180,170,.07)'; mapCtx.fillRect(x + cell - Math.max(1, cell * 0.04), y, Math.max(1, cell * 0.04), cell + 0.7); }
      }
    }

    // ---- 墙脚接触阴影（往南压一格） ----
    for (let wy = 0; wy < W; wy++) {
      for (let wx = 0; wx < W; wx++) {
        const gx = x0 + wx, gy = y0 + wy;
        if (!inMap(gx, gy)) continue;
        const i = gy * N + gx;
        if (!grid[i] || wall(gx, gy + 1)) continue;
        const sg = mapCtx.createLinearGradient(0, cellY(wy) + cell, 0, cellY(wy) + cell * 1.55);
        sg.addColorStop(0, 'rgba(0,0,0,.45)');
        sg.addColorStop(1, 'rgba(0,0,0,0)');
        mapCtx.fillStyle = sg;
        mapCtx.fillRect(cellX(wx), cellY(wy) + cell, cell + 0.7, cell * 0.55);
      }
    }
  }

  function sx(wx) { return (wx - st.camX) * cell + shx; }
  function sy(wy) { return (wy - st.camY) * cell + shy; }

  /* ---------------- 钥匙 ---------------- */
  function keyShape(cx, cy, r, fake, known, pulse, now) {
    ctx.save();
    ctx.translate(cx, cy + Math.sin(now / 520 + (fake ? 1.7 : 0)) * r * 0.16);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cell * (fake ? 0.9 : 0.78));
    if (fake) {
      g.addColorStop(0, 'rgba(255,92,224,' + (0.36 + 0.2 * pulse) + ')');
      g.addColorStop(1, 'rgba(140,0,138,0)');
    } else {
      g.addColorStop(0, 'rgba(255,212,90,' + (0.30 + 0.16 * pulse) + ')');
      g.addColorStop(1, 'rgba(255,212,90,0)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(-cell, -cell, cell * 2, cell * 2);

    const main = fake ? COLORS.FAKE : COLORS.KEY;
    const dark = fake ? COLORS.FAKE_DARK : COLORS.KEY_DARK;
    ctx.lineCap = 'round';
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(2, r * 0.5);
    ctx.beginPath(); ctx.arc(0, -r * 0.42, r * 0.44, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = main;
    ctx.lineWidth = Math.max(1.4, r * 0.32);
    ctx.beginPath(); ctx.arc(0, -r * 0.42, r * 0.44, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = Math.max(1.6, r * 0.28);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, r * 0.9);
    ctx.moveTo(0, r * 0.52); ctx.lineTo(r * 0.4, r * 0.52);
    ctx.moveTo(0, r * 0.82); ctx.lineTo(r * 0.32, r * 0.82);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.beginPath(); ctx.arc(-r * 0.14, -r * 0.56, Math.max(1, r * 0.09), 0, Math.PI * 2); ctx.fill();

    if (fake) {
      ctx.fillStyle = '#2b0710';
      ctx.beginPath(); ctx.arc(-r * 0.19, -r * 0.46, r * 0.11, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(r * 0.19, -r * 0.46, r * 0.11, 0, Math.PI * 2); ctx.fill();
    }
    if (known && fake) {
      ctx.strokeStyle = COLORS.FAKE_RING;
      ctx.lineWidth = Math.max(2, cell * 0.07);
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      roundRect(ctx, -r * 1.1, -r * 1.14, r * 2.2, r * 2.28, r * 0.32);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /* ---------------- 画面外箭头 ---------------- */
  function arrow(gx, gy, angle, color, scale, now) {
    const x = gx * cell, y = gy * cell, r = cell * (scale || 0.3);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 320);
    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 0.28;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.55, -r * 0.62);
    ctx.lineTo(-r * 0.2, 0);
    ctx.lineTo(-r * 0.55, r * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- 玩家 ---------------- */
  function drawPlayer(p, isSelf, dim, now) {
    const px = sx(p.x), py = sy(p.y);
    const bob = Math.sin(now / 330 + (isSelf ? 0 : p.x * 1.7)) * cell * (isSelf ? 0.022 : 0.012);
    const cx = px + cell / 2, cy = py + cell / 2 + bob;
    const half = cell * 0.33;
    const col = p.color || '#ffffff';

    ctx.save();
    if (dim) ctx.globalAlpha = 0.75;

    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.beginPath();
    ctx.ellipse(cx, py + cell * 0.79, half * 0.92, cell * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    const glowR = cell * (isSelf ? 0.95 : 0.62);
    const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    if (isSelf) {
      gg.addColorStop(0, 'rgba(255,232,190,.26)');
      gg.addColorStop(0.5, 'rgba(255,206,140,.09)');
      gg.addColorStop(1, 'rgba(255,180,100,0)');
    } else {
      gg.addColorStop(0, 'rgba(255,255,255,.09)');
      gg.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = gg;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    const bg = ctx.createLinearGradient(cx, cy - half, cx, cy + half);
    bg.addColorStop(0, shade(col, 1.3));
    bg.addColorStop(0.6, col);
    bg.addColorStop(1, shade(col, 0.66));
    ctx.fillStyle = bg;
    roundRect(ctx, cx - half, cy - half, half * 2, half * 2, half * 0.56);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.20)';
    roundRect(ctx, cx - half * 0.6, cy - half * 0.68, half * 1.2, half * 0.36, half * 0.18);
    ctx.fill();

    const eyeY = cy + half * 0.04;
    ctx.fillStyle = 'rgba(10,5,8,.85)';
    ctx.beginPath();
    ctx.arc(cx - half * 0.33, eyeY, Math.max(1.2, half * 0.18), 0, Math.PI * 2);
    ctx.arc(cx + half * 0.33, eyeY, Math.max(1.2, half * 0.18), 0, Math.PI * 2);
    ctx.fill();
    if (isSelf) {
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.beginPath();
      ctx.arc(cx - half * 0.29, eyeY - half * 0.06, Math.max(0.8, half * 0.07), 0, Math.PI * 2);
      ctx.arc(cx + half * 0.37, eyeY - half * 0.06, Math.max(0.8, half * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.lineWidth = Math.max(1.4, cell * (isSelf ? 0.052 : 0.04));
    if (isSelf) {
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.8 + 0.2 * Math.sin(now / 430)) + ')';
      ctx.shadowColor = 'rgba(255,238,205,.9)';
      ctx.shadowBlur = cell * 0.3;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,.68)';
    }
    roundRect(ctx, cx - half, cy - half, half * 2, half * 2, half * 0.56);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (p.bot) {
      ctx.fillStyle = 'rgba(8,3,6,.75)';
      roundRect(ctx, cx - half * 0.3, cy - half - cell * 0.13, half * 0.6, cell * 0.075, cell * 0.04);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- 怪物 ---------------- */
  function drawMonster(mm, now) {
    const mx = sx(mm.x) + cell / 2, my = sy(mm.y) + cell / 2;
    const stunned = mm.st === 'stun';
    const chasing = mm.st === 'chase';
    const r = cell * (stunned ? 0.3 : 0.37) * (1 + 0.05 * Math.sin(now / 200));

    const g = ctx.createRadialGradient(mx, my, 0, mx, my, r * 2.7);
    g.addColorStop(0, stunned ? 'rgba(255,160,90,.40)' : (chasing ? 'rgba(255,36,58,.60)' : 'rgba(180,16,46,.40)'));
    g.addColorStop(0.5, chasing ? 'rgba(255,36,58,.14)' : 'rgba(160,16,46,.09)');
    g.addColorStop(1, 'rgba(110,0,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(mx - r * 2.7, my - r * 2.7, r * 5.4, r * 5.4);

    ctx.strokeStyle = 'rgba(34,2,12,.92)';
    ctx.lineWidth = Math.max(1.5, cell * 0.048);
    ctx.lineCap = 'round';
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + (k - 2.5) * 0.42 + Math.sin(now / 430 + k) * 0.18;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(a) * r * 0.55, my + Math.sin(a) * r * 0.55);
      ctx.quadraticCurveTo(
        mx + Math.cos(a + 0.3) * r * 1.1, my + Math.sin(a + 0.3) * r * 1.1,
        mx + Math.cos(a) * r * 1.5, my + Math.sin(a) * r * 1.5);
      ctx.stroke();
    }

    const bg = ctx.createRadialGradient(mx - r * 0.34, my - r * 0.42, r * 0.05, mx, my, r);
    bg.addColorStop(0, '#4b0f25');
    bg.addColorStop(1, COLORS.MONSTER);
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,86,106,.32)';
    ctx.lineWidth = Math.max(1, cell * 0.03);
    ctx.stroke();

    const eyeCol = stunned ? 'rgba(255,212,90,.85)' : (chasing ? '#ff3b52' : COLORS.MONSTER_EYE);
    ctx.fillStyle = eyeCol;
    ctx.shadowColor = eyeCol;
    ctx.shadowBlur = cell * (chasing ? 0.5 : 0.26);
    ctx.beginPath();
    ctx.arc(mx - r * 0.31, my - r * 0.13, r * 0.17, 0, Math.PI * 2);
    ctx.arc(mx + r * 0.31, my - r * 0.13, r * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(16,0,6,.92)';
    ctx.beginPath();
    ctx.arc(mx - r * 0.31, my - r * 0.13, r * 0.065, 0, Math.PI * 2);
    ctx.arc(mx + r * 0.31, my - r * 0.13, r * 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,110,130,.5)';
    ctx.lineWidth = Math.max(1, cell * 0.028);
    ctx.beginPath();
    ctx.arc(mx, my + r * 0.32, r * 0.26, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    if (stunned) {
      ctx.fillStyle = 'rgba(255,212,90,.95)';
      for (let k = 0; k < 3; k++) {
        const a = (now / 680) * Math.PI * 2 + k * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.arc(mx + Math.cos(a) * cell * 0.3, my + Math.sin(a) * cell * 0.3 - cell * 0.18,
          Math.max(1.4, cell * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ---------------- 终点 ---------------- */
  function drawExit(ex, ey, active, now) {
    const x = sx(ex), y = sy(ey);
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    ctx.save();
    const bg = ctx.createLinearGradient(x, y, x, y + cell);
    bg.addColorStop(0, active ? '#5c0a10' : '#2a0710');
    bg.addColorStop(1, active ? '#8d1218' : '#150309');
    ctx.fillStyle = bg;
    roundRect(ctx, x + cell * 0.05, y + cell * 0.05, cell * 0.9, cell * 0.9, cell * 0.18);
    ctx.fill();

    if (!active) {
      ctx.strokeStyle = 'rgba(255,70,70,.28)';
      ctx.lineWidth = Math.max(1, cell * 0.04);
      roundRect(ctx, x + cell * 0.2, y + cell * 0.2, cell * 0.6, cell * 0.6, cell * 0.12);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const g = ctx.createRadialGradient(x + cell / 2, y + cell / 2, 0, x + cell / 2, y + cell / 2, cell * 0.58);
    g.addColorStop(0, 'rgba(255,130,130,' + (0.5 + 0.3 * pulse) + ')');
    g.addColorStop(0.55, 'rgba(255,46,46,.3)');
    g.addColorStop(1, 'rgba(255,46,46,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - cell * 0.2, y - cell * 0.2, cell * 1.4, cell * 1.4);

    ctx.strokeStyle = COLORS.EXIT_GOLD;
    ctx.lineWidth = Math.max(1.6, cell * 0.07);
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    roundRect(ctx, x + cell * 0.1, y + cell * 0.1, cell * 0.8, cell * 0.8, cell * 0.15);
    ctx.stroke();
    ctx.globalAlpha = 1;

    for (let k = 0; k < 3; k++) {
      const t = ((now / 950) + k / 3) % 1;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.fillStyle = COLORS.EXIT_GOLD;
      ctx.beginPath();
      ctx.arc(x + cell * (0.28 + 0.22 * k) + Math.sin(t * 6 + k) * cell * 0.05,
        y + cell * (0.9 - t * 0.78), Math.max(1, cell * 0.045), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ---------------- 雾：低分辨率上采样，边缘圆润 ---------------- */
  /* 纯黑的雾会让画面 80% 变成一块死掉的黑色矩形。真实的黑暗里也有东西：
     火把照亮空气里的尘，近处偏暖、远处沉下去。所以在雾的颜色里按到玩家的
     距离掺一点暖色 —— 只改「看不见的地方长什么样」，一格可见范围都不多给。 */
  const FOG_C = (VIEW - 1) / 2;
  function paintFog(alpha) {
    const d = fogImg.data;
    for (let k = 0; k < VIEW * VIEW; k++) {
      const a = alpha[k];
      const o = k * 4;
      const vx = k % VIEW, vy = (k - vx) / VIEW;
      const dx = vx - FOG_C, dy = vy - FOG_C;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 只在高浓度（真正看不见）的地方掺暖光；记忆层/可见区保持中性
      const solid = Math.min(1, Math.max(0, a));
      // 火把半径内（dist 小）的黑是「有温度的黑」，随距离渐冷到几乎全黑。
      // 半径放宽到 5 格、用线性而非平方衰减，让整块看不见的区域都有暗暖色
      // 而不是一坨死黑；只有最远的四角才真正压到纯黑。
      let w = 1 - dist / 5.2;
      w = w > 0 ? w * solid : 0;
      // 轻微抖动打散色带
      const jit = ((k * 37 + (k >> 3) * 91) % 9) - 4;
      d[o] = Math.max(0, Math.min(255, Math.round(12 + 46 * w) + jit));
      d[o + 1] = Math.max(0, Math.min(255, Math.round(7 + 30 * w) + (jit >> 1)));
      d[o + 2] = Math.max(0, Math.min(255, Math.round(9 + 18 * w)));
      d[o + 3] = Math.round(solid * 255);
    }
    fogLowCtx.putImageData(fogImg, 0, 0);
    fogCtx.clearRect(0, 0, s, s);
    fogCtx.imageSmoothingEnabled = true;
    fogCtx.drawImage(fogLow, 0, 0, VIEW, VIEW, 0, 0, s, s);
  }

  /* ---------------- 主绘制 ---------------- */
  function draw(data) {
    st = data;
    shx = data.ox || 0; shy = data.oy || 0;
    if (!data.grid || !data.sight) return;
    if (mapKey !== data.mapHash || mapCamX !== data.camX || mapCamY !== data.camY) {
      paintMap(data.grid, data.camX, data.camY);
      mapKey = data.mapHash; mapCamX = data.camX; mapCamY = data.camY;
    }
    if (fogMapKey !== data.mapHash) { fogAlpha.fill(1); fogAt = 0; fogMapKey = data.mapHash; }
    // 上一帧刚点亮、这一帧才淡出的格子也走记忆层：否则换图的那一帧会整屏"闪白"


    const target = fogTargets(visionMask, data.sight, data.camX, data.camY);
    const dt = fogAt ? Math.min(FOG_FADE_MS, Math.max(0, data.now - fogAt)) : FOG_FADE_MS;
    fogAt = data.now;
    approachFog(fogAlpha, target, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    // 底图四周各留了 1 格缓冲，实际显示区从 (cell, cell) 起、宽高 VIEW*cell = s
    ctx.drawImage(mapCanvas,
      cell * dpr, cell * dpr, s * dpr, s * dpr, shx, shy, s, s);

    const pulse = 0.5 + 0.5 * Math.sin(data.now / 260);
    const lit = data.sight.lit;
    const inView = (wx, wy) => wx >= data.camX && wx < data.camX + VIEW && wy >= data.camY && wy < data.camY + VIEW;
    const ex = xOf(data.exitI), ey = yOf(data.exitI);

    if (data.exitI >= 0 && lit[data.exitI] && inView(ex, ey)) drawExit(ex, ey, !!data.exitActive, data.now);

    for (let k = 0; k < data.keys.length; k++) {
      const key = data.keys[k];
      if (key.taken) continue;
      const kx = xOf(key.i), ky = yOf(key.i);
      if (!lit[key.i] || !inView(kx, ky)) continue;
      const isFake = data.fakeIds.indexOf(k) !== -1;
      keyShape(sx(kx) + cell / 2, sy(ky) + cell / 2, cell * 0.29, isFake,
        !!data.distinguish && isFake, pulse, data.now);
    }

    if (data.monster && lit[idx(data.monster.x, data.monster.y)]
        && inView(data.monster.x, data.monster.y)) drawMonster(data.monster, data.now);

    for (let k = 0; k < data.players.length; k++) {
      const p = data.players[k];
      const pi = idx(p.x, p.y);
      const isSelf = p.id === data.viewId;
      if (!lit[pi] && !(data.allyVision && !isSelf)) continue;
      if (!inView(p.x, p.y)) continue;
      if (!p.alive) {
        const px = sx(p.x), py = sy(p.y);
        ctx.save();
        ctx.strokeStyle = COLORS.CORPSE;
        ctx.lineWidth = Math.max(2, cell * 0.1);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px + cell * 0.3, py + cell * 0.32);
        ctx.lineTo(px + cell * 0.7, py + cell * 0.68);
        ctx.moveTo(px + cell * 0.7, py + cell * 0.32);
        ctx.lineTo(px + cell * 0.3, py + cell * 0.68);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      drawPlayer(p, isSelf, !lit[pi], data.now);
    }

    // ---- 火把暖光 ----
    const cx = (data.px - data.camX + 0.5) * cell + shx;
    const cy = (data.py - data.camY + 0.5) * cell + shy;
    const flick = 1 + 0.03 * Math.sin(data.now / 170) + 0.018 * Math.sin(data.now / 61);
    const torch = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 4.3 * flick);
    torch.addColorStop(0, 'rgba(255,198,124,.16)');
    torch.addColorStop(0.4, 'rgba(255,170,98,.085)');
    torch.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = torch;
    ctx.fillRect(0, 0, s, s);
    ctx.globalCompositeOperation = 'source-over';

    // ---- 雾 ----
    paintFog(fogAlpha);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fogCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- 暗角 ----
    const vg = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.74);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, s, s);

    // ---- 能力①：钥匙透视 ----
    if (data.keyBeacons) {
      for (let k = 0; k < data.keys.length; k++) {
        const key = data.keys[k];
        if (key.taken) continue;
        const kx = xOf(key.i), ky = yOf(key.i);
        if (inView(kx, ky)) {
          const bx = sx(kx) + cell / 2, by = sy(ky) + cell / 2;
          ctx.save();
          ctx.globalAlpha = 0.5 + 0.35 * pulse;
          ctx.fillStyle = COLORS.BEACON;
          ctx.shadowColor = COLORS.BEACON;
          ctx.shadowBlur = cell * 0.28;
          ctx.beginPath();
          ctx.moveTo(bx, by - cell * 0.13);
          ctx.lineTo(bx + cell * 0.13, by);
          ctx.lineTo(bx, by + cell * 0.13);
          ctx.lineTo(bx - cell * 0.13, by);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          const e = projectEdge(kx, ky, data.camX, data.camY);
          if (e) arrow(e.gx, e.gy, e.angle, COLORS.BEACON, 0.28, data.now);
        }
      }
    }

    // ---- 能力④：队友透视 ----
    if (data.allyVision) {
      for (let k = 0; k < data.players.length; k++) {
        const p = data.players[k];
        if (p.id === data.viewId || !p.alive) continue;
        if (!inView(p.x, p.y)) {
          const e = projectEdge(p.x, p.y, data.camX, data.camY);
          if (e) arrow(e.gx, e.gy, e.angle, p.color || '#ffffff', 0.36, data.now);
        } else if (!lit[idx(p.x, p.y)]) {
          ctx.save();
          ctx.fillStyle = p.color || '#ffffff';
          ctx.globalAlpha = 0.45 + 0.25 * pulse;
          ctx.shadowColor = p.color || '#ffffff';
          ctx.shadowBlur = cell * 0.28;
          ctx.beginPath();
          ctx.arc(sx(p.x) + cell / 2, sy(p.y) + cell / 2, cell * 0.15, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // ---- 能力③：终点透视 ----
    if (data.exitVision && data.exitI >= 0) {
      if (inView(ex, ey)) {
        ctx.save();
        ctx.strokeStyle = COLORS.EXIT_GOLD;
        ctx.lineWidth = Math.max(2, cell * 0.08);
        ctx.shadowColor = COLORS.EXIT_GOLD;
        ctx.shadowBlur = cell * 0.36;
        ctx.globalAlpha = 0.6 + 0.3 * pulse;
        roundRect(ctx, sx(ex) + cell * 0.07, sy(ey) + cell * 0.07, cell * 0.86, cell * 0.86, cell * 0.14);
        ctx.stroke();
        ctx.restore();
      } else {
        const e = projectEdge(ex, ey, data.camX, data.camY);
        if (e) arrow(e.gx, e.gy, e.angle, COLORS.EXIT_GOLD, 0.46, data.now);
      }
    }
  }

  return { resize, draw, get cell() { return cell; }, get size() { return s; } };
}