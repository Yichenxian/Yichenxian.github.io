/* ============================================================
   bitcrush.js —— 8bit 复古音频核心（零阶保持 + 位深量化）
   ------------------------------------------------------------
   链路（与 Web Audio 里 BitCrusher 节点等价）：
     混单声道 → 统一到 44100 → 去直流 → 抗混叠低通 → 归一化
     → 抽取(零阶保持) → 位深量化 → 首尾淡入淡出

   为什么只存 1/hold 的样本：
     零阶保持的输出 = 「每一级台阶重复 hold 次」，信息量和降采样后完全相同。
     所以处理结果按 packRate(11025) 存，播放前用 expand() 展开回 workRate(44100)，
     波形与原速渲染逐样本一致，而文件体积只有 1/4。

   这套运算刻意写成纯 JS（不依赖 AudioWorklet / OfflineAudioContext）：
     1. 浏览器与 Node 共用同一份代码 —— 预生成的默认曲和玩家上传的曲子
        走完全相同的算法，不会出现「线上和离线听感不一样」；
     2. 不需要额外加载 worklet 模块文件，静态托管零配置；
     3. 结果可缓存、可复现，同一个输入永远得到同一个输出。

   API：
     Bit8.OPTS                      默认参数
     Bit8.hold()                    台阶长度（workRate / packRate）
     Bit8.process(channels, rate)   处理 → { packed, rate, hold, seconds }
     Bit8.expand(packed, hold)      展开成 workRate 下的可播放样本
     Bit8.encodeWav(samples, rate)  打包 8bit 单声道 WAV
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bit8 = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==================== 参数 ====================
  var OPTS = {
    workRate: 44100,   // 内部工作采样率（与绝大多数音频文件一致，省一次重采样）
    packRate: 11025,   // 存储/有效采样率，必须是 workRate 的整数分之一
    bits: 8,           // 量化位深
    cutoff: 3400,      // 抗混叠低通（Hz）。这是 R2-C 的关键：不滤就刺耳
    lpPasses: 2,       // 低通串联次数，2 次二阶 = 4 阶 (-24dB/oct)
    peak: 0.92,        // 归一化峰值，防止量化后削顶
    fadeMs: 6,         // 首尾淡入淡出，消掉循环接缝的爆音
    dcHz: 30           // 去直流高通截止
  };

  function holdSamples() {
    return Math.max(1, Math.round(OPTS.workRate / OPTS.packRate));
  }

  // ==================== 基础运算 ====================

  // 二阶（RBJ）低通，就地改写
  function lowpass(buf, rate, freq, passes) {
    var f = Math.max(20, Math.min(freq, rate * 0.45));
    var w0 = 2 * Math.PI * f / rate;
    var cosw = Math.cos(w0), sinw = Math.sin(w0);
    var alpha = sinw / (2 * 0.7071067811865476);   // Butterworth Q
    var a0 = 1 + alpha;
    var b0 = ((1 - cosw) / 2) / a0;
    var b1 = (1 - cosw) / a0;
    var b2 = b0;
    var a1 = (-2 * cosw) / a0;
    var a2 = (1 - alpha) / a0;

    for (var p = 0; p < (passes || 1); p++) {
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < buf.length; i++) {
        var x = buf[i];
        var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
      }
    }
  }

  // 一阶高通，切掉直流，避免量化后整体偏移
  function dcBlock(buf, rate, freq) {
    var a = 1 / (1 + 2 * Math.PI * freq / rate);
    var x1 = 0, y1 = 0;
    for (var i = 0; i < buf.length; i++) {
      var x = buf[i];
      var y = a * (y1 + x - x1);
      x1 = x; y1 = y; buf[i] = y;
    }
  }

  // 线性插值重采样
  function resample(src, srcRate, dstRate) {
    var n = Math.max(1, Math.floor(src.length * dstRate / srcRate));
    var out = new Float32Array(n);
    var step = srcRate / dstRate;
    var pos = 0, last = src.length - 1;
    for (var i = 0; i < n; i++) {
      var i0 = pos | 0;
      if (i0 > last) i0 = last;
      var i1 = i0 < last ? i0 + 1 : last;
      var t = pos - i0;
      out[i] = src[i0] + (src[i1] - src[i0]) * t;
      pos += step;
    }
    return out;
  }

  function normalize(buf, target) {
    var peak = 0;
    for (var i = 0; i < buf.length; i++) {
      var a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) peak = a;
    }
    if (peak < 1e-6) return;
    var g = target / peak;
    for (var j = 0; j < buf.length; j++) buf[j] *= g;
  }

  function fade(buf, rate, ms) {
    var n = Math.min(buf.length >> 1, Math.round(rate * ms / 1000));
    for (var i = 0; i < n; i++) {
      var g = i / n;
      buf[i] *= g;
      buf[buf.length - 1 - i] *= g;
    }
  }

  // 位深量化：把样本吸附到 2^bits 个台阶
  function quantize(buf, bits) {
    var step = Math.pow(2, Math.max(1, Math.min(16, bits | 0)) - 1);
    for (var i = 0; i < buf.length; i++) {
      var v = buf[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      buf[i] = Math.round(v * step) / step;
    }
  }

  // ==================== 处理链 ====================

  // channels: Float32Array 或 Float32Array[]；srcRate: 源采样率
  function process(channels, srcRate, overrides) {
    var o = {};
    for (var k in OPTS) if (OPTS.hasOwnProperty(k)) o[k] = OPTS[k];
    if (overrides) for (var k2 in overrides) if (overrides.hasOwnProperty(k2)) o[k2] = overrides[k2];

    var chs = isChannelList(channels) ? channels : [channels];
    var n = chs[0].length;
    var mono = new Float32Array(n);

    // 1) 混单声道（低通到 3.4k 之后，立体声像基本没剩多少，单声道还能省一半体积）
    if (chs.length === 1) {
      mono.set(chs[0]);
    } else {
      for (var i = 0; i < n; i++) {
        var sum = 0;
        for (var c = 0; c < chs.length; c++) sum += chs[c][i];
        mono[i] = sum / chs.length;
      }
    }

    // 2) 统一到工作采样率（高了先抗混叠再降，低了直接插值）
    var work = mono;
    if (srcRate !== o.workRate) {
      if (srcRate > o.workRate) lowpass(work, srcRate, o.workRate * 0.45, 2);
      work = resample(work, srcRate, o.workRate);
    }

    // 3) 去直流 → 抗混叠低通 → 淡化 → 归一化
    dcBlock(work, o.workRate, o.dcHz);
    lowpass(work, o.workRate, o.cutoff, o.lpPasses);
    fade(work, o.workRate, o.fadeMs);
    normalize(work, o.peak);

    // 4) 抽取（等价于零阶保持后按 hold 取样），5) 位深量化
    var hold = Math.max(1, Math.round(o.workRate / o.packRate));
    var packed = new Float32Array(Math.floor(work.length / hold));
    for (var j = 0; j < packed.length; j++) packed[j] = work[j * hold];
    quantize(packed, o.bits);

    return {
      packed: packed,
      rate: o.workRate / hold,
      hold: hold,
      seconds: packed.length / (o.workRate / hold)
    };
  }

  function isChannelList(x) {
    return !!x && typeof x.length === 'number' && x.length > 0 &&
           typeof x[0] === 'object' && x[0] !== null && typeof x[0].length === 'number';
  }

  // 零阶保持展开：把 packRate 下的样本铺到任意输出采样率
  // 设备采样率是 44100 还是 48000 都能正确还原台阶（不是线性插值）
  function expand(packed, outRate) {
    outRate = Math.round(outRate || OPTS.workRate);
    var packRate = OPTS.packRate;
    var n = Math.round(packed.length * outRate / packRate);
    var out = new Float32Array(n);
    var step = packRate / outRate;
    var last = packed.length - 1;
    for (var i = 0; i < n; i++) {
      var j = Math.floor(i * step);
      out[i] = packed[j > last ? last : j];
    }
    return out;
  }

  // ==================== WAV 打包（8bit 无符号单声道） ====================
  function writeStr(view, off, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  function encodeWav(samples, rate) {
    var len = samples.length;
    var ab = new ArrayBuffer(44 + len);
    var v = new DataView(ab);

    writeStr(v, 0, 'RIFF');
    v.setUint32(4, 36 + len, true);
    writeStr(v, 8, 'WAVE');
    writeStr(v, 12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);            // PCM
    v.setUint16(22, 1, true);            // 单声道
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);         // byteRate = rate * 1ch * 1byte
    v.setUint16(32, 1, true);            // blockAlign
    v.setUint16(34, 8, true);
    writeStr(v, 36, 'data');
    v.setUint32(40, len, true);

    for (var i = 0, o = 44; i < len; i++, o++) {
      var s = samples[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      v.setUint8(o, Math.round(s * 127.5 + 127.5));
    }
    return ab;
  }

  return {
    OPTS: OPTS,
    hold: holdSamples,
    process: process,
    expand: expand,
    encodeWav: encodeWav
  };
}));
