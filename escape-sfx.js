/* ============================================================
   合作逃生 · 音效（程序化合成，不带任何音频素材）
   ------------------------------------------------------------
   和迷宫那边的 BEEP 一个路子：振荡器 + 噪声现场合成，体积为零、
   离线可放、改参数就是改文件，不用重新压素材。

   AudioContext 复用 window.MazeAudio 提供的那个（escape.html 内联桩 /
   maze.js），一个页面只开一个上下文；两个上下文各自跑时钟，会让
   「背景音乐 + 音效」互相拖拍。

   入口是音乐条上的「音效」徽标（#mbSfx）：点一下开关，滚轮调音量，
   开关与音量都存 localStorage，跟背景音乐的音量互相独立。
   ============================================================ */

export const SFX_CFG = {
  VOL_DEFAULT: 70,        // 默认音效音量（%）。背景音乐默认 48，音效要更突出一点
  KEY_ON: 'escape_sfx_on',
  KEY_VOL: 'escape_sfx_vol',
  MAX_VOICES: 14,         // 同时在响的声部上限：极端刷屏时宁可丢一声，也别爆音掉帧
  // 同名音效的最小间隔（ms）：脚步是唯一会连着响几十次的音，必须限流
  GAP_MS: { step: 55, click: 45, heart: 320, bump: 90 }
};

/**
 * 建一个音效播放器。第一次 play 时才创建音频节点（浏览器要求用户手势）。
 * 返回 { play, setEnabled, setVolume, enabled, volume, state, count, last }
 */
export function createSfx() {
  let ac = null, master = null, echoSend = null, noiseBuf = null;
  let enabled = true;
  let vol = SFX_CFG.VOL_DEFAULT / 100;
  let voices = 0;
  let stepAlt = false;
  const lastAt = {};
  const stats = { count: 0, last: '', byName: {} };

  const btn = document.getElementById('mbSfx');

  /* ---------------- 音频图 ---------------- */
  function build() {
    master = ac.createGain();
    master.gain.value = enabled ? vol : 0;
    master.connect(ac.destination);

    // 一点点回声：钥匙 / 复活 / 通关这类提示音有余韵才不干瘪。
    // 只做 0.135s 的单抽头 + 回授，够用且不会糊住急促的脚步。
    const delay = ac.createDelay(0.6);
    delay.delayTime.value = 0.135;
    const fb = ac.createGain();
    fb.gain.value = 0.24;
    const wet = ac.createGain();
    wet.gain.value = 0.3;
    echoSend = ac.createGain();
    echoSend.gain.value = 1;
    echoSend.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(master);
  }

  /**
   * 拿到一个「正在跑」的上下文；没跑起来就返回 null。
   * 关键：不能往暂停的上下文里排音符 —— 它的 currentTime 是冻住的，
   * 等恢复播放时所有音符会在同一瞬间炸出来。
   */
  function ensure() {
    if (!ac) {
      if (window.MazeAudio && window.MazeAudio.ensure) ac = window.MazeAudio.ensure();
      if (!ac) {
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
      }
      if (ac) build();
    }
    if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
    return ac && ac.state === 'running' ? ac : null;
  }

  function noiseBuffer() {
    if (!noiseBuf) {
      const n = Math.floor(ac.sampleRate * 0.5);
      noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  /** 一个音：freq → to（可选滑音），指数包络。o.at 是相对当前的延迟（秒） */
  function tone(freq, dur, o) {
    if (voices >= SFX_CFG.MAX_VOICES) return;
    o = o || {};
    const t = ac.currentTime + (o.at || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(Math.max(20, freq), t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + (o.glide || dur));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const peak = Math.max(0.0002, o.peak || 0.06);
    const atk = Math.min(o.atk || 0.006, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(master);
    if (o.echo) g.connect(echoSend);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    voices++;
    osc.onended = () => { voices--; osc.disconnect(); g.disconnect(); };
  }

  /** 一段噪声：滤镜扫频做成「脚步 / 呼呼风 / 撞击」的质感 */
  function hiss(dur, o) {
    if (voices >= SFX_CFG.MAX_VOICES) return;
    o = o || {};
    const t = ac.currentTime + (o.at || 0);
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer();
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.filter || 'lowpass';
    f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(o.from || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const g = ac.createGain();
    const peak = Math.max(0.0002, o.peak || 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.atk || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    if (o.echo) g.connect(echoSend);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.02);
    voices++;
    src.onended = () => { voices--; src.disconnect(); f.disconnect(); g.disconnect(); };
  }

  /* ---------------- 音效表 ---------------- */
  // 约定：提示音（钥匙 / 复活 / 通关）走高音 + 回声；伤害 / 死亡走低音 + 噪声；
  // 音量整体压在 0.02~0.15，既能听清又不会盖过背景音乐。
  const KIT = {
    // 走一格。唯一会高频重复的音，必须轻，两个音高轮换着敲才不像节拍器
    step() {
      stepAlt = !stepAlt;
      hiss(0.05, { filter: 'bandpass', from: stepAlt ? 1150 : 980, q: 1.6, peak: 0.06 });
      tone(stepAlt ? 118 : 132, 0.07, { type: 'sine', to: 74, peak: 0.055, atk: 0.004 });
    },
    // 撞墙：比脚步更闷、更短（低频 + 一点方波的「咯」）。
    // 顶着墙按住不放时只响第一下（由 escape-main 按方向去重），所以可以放心做厚一点
    bump() {
      hiss(0.045, { filter: 'lowpass', from: 620, to: 240, peak: 0.06 });
      tone(92, 0.1, { type: 'sine', to: 58, peak: 0.075 });
      tone(196, 0.05, { type: 'square', to: 130, peak: 0.022 });
    },
    // 真钥匙：上行两音 + 余韵，和假钥匙的下坠形成最直接的反差
    key() {
      tone(880, 0.09, { type: 'square', peak: 0.055 });
      tone(1320, 0.2, { type: 'square', peak: 0.05, at: 0.075, echo: true });
      tone(1760, 0.26, { type: 'triangle', peak: 0.03, at: 0.14, echo: true });
    },
    // 假钥匙：两条锯齿互相打拍子做出「不对劲」的粗糙感，再压一个下坠的低音
    fake() {
      tone(233, 0.18, { type: 'sawtooth', to: 140, peak: 0.075 });
      tone(247, 0.18, { type: 'sawtooth', to: 131, peak: 0.05, detune: -22 });
      tone(110, 0.34, { type: 'square', to: 55, peak: 0.06, at: 0.08 });
      hiss(0.16, { filter: 'highpass', from: 2200, peak: 0.05 });
    },
    // 假钥匙掉血：一记闷响（紧跟在 fake 之后，要短，别拖泥带水）
    hurt() {
      hiss(0.16, { filter: 'lowpass', from: 1600, to: 260, peak: 0.1 });
      tone(200, 0.24, { type: 'sawtooth', to: 62, peak: 0.075 });
    },
    // 被怪物撞到：比假钥匙更重，加一个 60Hz 的胸腔感
    hit_monster() {
      hiss(0.22, { filter: 'lowpass', from: 900, to: 160, peak: 0.13 });
      tone(150, 0.3, { type: 'square', to: 48, peak: 0.09 });
      tone(60, 0.34, { type: 'sine', to: 38, peak: 0.1, at: 0.01 });
    },
    // 倒下：下行的四个音 + 一记长低频，留够时间让队友反应
    death() {
      [440, 349, 262, 196].forEach((f, i) => tone(f, 0.22, { type: 'square', at: i * 0.1, peak: 0.065 }));
      tone(98, 1.2, { type: 'triangle', to: 49, peak: 0.07, atk: 0.03 });
      hiss(0.6, { filter: 'lowpass', from: 1100, to: 140, peak: 0.05, at: 0.35 });
    },
    // 抢救成功：上行的琶音，是全游戏最「亮」的一声，奖励感要足
    revive() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', at: i * 0.055, peak: 0.05, echo: true }));
      tone(1568, 0.4, { type: 'sine', peak: 0.025, at: 0.22, echo: true });
    },
    // 穿墙：带通扫频的「呼——」，配一记低频落地
    wall() {
      hiss(0.32, { filter: 'bandpass', from: 240, to: 2600, q: 2.4, peak: 0.09 });
      tone(72, 0.22, { type: 'sine', to: 44, peak: 0.08 });
    },
    // 队友位置解锁：两记钟声，别太抢戏
    unlock() {
      tone(1047, 0.55, { type: 'sine', peak: 0.045, echo: true });
      tone(1568, 0.62, { type: 'sine', peak: 0.028, at: 0.09, echo: true });
    },
    // 钥匙集齐、终点激活：四音上行小号角
    exit() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: 'triangle', at: i * 0.09, peak: 0.05, echo: true }));
      hiss(0.55, { filter: 'highpass', from: 2600, peak: 0.02, at: 0.36 });
    },
    // 通关：四音阶 + 尾巴上一个和弦收住，避免听起来像半截
    win() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'square', at: i * 0.11, peak: 0.055 }));
      [523, 659, 784, 1047].forEach(f => tone(f, 0.85, { type: 'triangle', at: 0.46, peak: 0.03, echo: true }));
    },
    // 失败：下行锯齿，最后一个长低频慢慢沉下去
    lose() {
      [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, { type: 'sawtooth', at: i * 0.17, peak: 0.06 }));
      tone(98, 1.5, { type: 'triangle', to: 44, peak: 0.075, at: 0.5 });
    },
    // 怪物贴身：心跳，两下（咚—咚）。低频几乎只能靠「体感」听，别调大
    heart() {
      tone(66, 0.13, { type: 'sine', to: 46, peak: 0.15 });
      tone(58, 0.11, { type: 'sine', to: 40, peak: 0.09, at: 0.16 });
    },
    // 怪物盯上你了：两声短促的嘶鸣，比心跳更「尖锐」，用来区分危险等级
    chase() {
      tone(330, 0.13, { type: 'sawtooth', peak: 0.05 });
      tone(494, 0.16, { type: 'sawtooth', at: 0.11, peak: 0.055 });
      hiss(0.26, { filter: 'bandpass', from: 380, to: 900, q: 3, peak: 0.035, at: 0.04 });
    },
    // 开局：三音上行，提示「可以动了」
    start() {
      [392, 523, 659].forEach((f, i) => tone(f, 0.22, { type: 'triangle', at: i * 0.085, peak: 0.045, echo: true }));
    },
    // UI 点击：越轻越好，它只是让按钮「有反馈」
    click() {
      tone(720, 0.04, { type: 'square', peak: 0.03 });
    }
  };

  /* ---------------- 对外接口 ---------------- */
  function play(name) {
    if (!enabled || vol <= 0) return;
    const kit = KIT[name];
    if (!kit) return;
    const gap = SFX_CFG.GAP_MS[name];
    if (gap) {
      const t = performance.now();
      if (t - (lastAt[name] || 0) < gap) return;
      lastAt[name] = t;
    }
    if (!ensure()) return;
    stats.count++;
    stats.last = name;
    stats.byName[name] = (stats.byName[name] || 0) + 1;
    kit();
  }

  function paint() {
    if (!btn) return;
    btn.classList.toggle('off', !enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.title = enabled
      ? '音效开 · ' + Math.round(vol * 100) + '%（点一下关闭，滚轮调音量）'
      : '音效关（点一下打开，滚轮调音量）';
  }

  function setEnabled(v, save) {
    enabled = !!v;
    // 音量被滚轮调到 0 了：打开时就给回默认值，否则「开着但没声」没法理解
    if (enabled && vol <= 0) vol = SFX_CFG.VOL_DEFAULT / 100;
    if (master) master.gain.value = enabled ? vol : 0;
    paint();
    if (save) { try { localStorage.setItem(SFX_CFG.KEY_ON, enabled ? '1' : '0'); } catch (e) { /* 隐私模式 */ } }
  }

  function setVolume(pct, save) {
    vol = Math.max(0, Math.min(100, Math.round(isFinite(pct) ? pct : SFX_CFG.VOL_DEFAULT))) / 100;
    if (master) master.gain.value = enabled ? vol : 0;
    paint();
    if (save) { try { localStorage.setItem(SFX_CFG.KEY_VOL, String(Math.round(vol * 100))); } catch (e) {} }
  }

  if (btn) {
    btn.addEventListener('click', () => {
      setEnabled(!enabled, true);
      if (enabled) play('click');               // 打开的瞬间给一记反馈音
    });
    // 滚轮微调音量：比再塞一个滑块省地方（音乐条在窄屏上已经挤满了）
    btn.addEventListener('wheel', e => {
      e.preventDefault();
      setVolume(vol * 100 - Math.sign(e.deltaY) * 10, true);
      play('click');
    }, { passive: false });
  }

  (function init() {
    try {
      const on = localStorage.getItem(SFX_CFG.KEY_ON);
      const v = localStorage.getItem(SFX_CFG.KEY_VOL);
      enabled = on === null ? true : on === '1';
      vol = (v === null || v === '') ? SFX_CFG.VOL_DEFAULT / 100 : Math.max(0, Math.min(1, parseFloat(v) / 100));
      if (!isFinite(vol)) vol = SFX_CFG.VOL_DEFAULT / 100;
    } catch (e) {
      enabled = true;
      vol = SFX_CFG.VOL_DEFAULT / 100;
    }
    paint();
  })();

  // 调试 / 回归用只读快照（正常玩法不依赖这里）
  window.EscapeSfx = {
    play, setEnabled, setVolume,
    get enabled() { return enabled; },
    get volume() { return Math.round(vol * 100); },
    get state() { return ac ? ac.state : 'none'; },
    get count() { return stats.count; },
    get last() { return stats.last; },
    get byName() { return Object.assign({}, stats.byName); },
    names() { return Object.keys(KIT); }
  };

  return window.EscapeSfx;
}
