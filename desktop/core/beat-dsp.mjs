// Cross-platform real-time Beat Tracker DSP (shared by macOS and Windows).
// Algorithm: 1024-pt Hann FFT -> 3-band log-magnitude spectral flux ->
// 8-second adaptive-mean-subtracted autocorrelation (118 BPM prior, half/double-beat harmonics) ->
// parabolic lag refinement -> exponentially weighted comb phase ->
// phase-locked loop (PLL) smoothing -> 4/4 low-band downbeat tracker.

export class BeatAnalyzer {
  constructor() {
    this.n = 1024;
    this.hop = 512;
    this.sr = 48000;
    this.cap = 1400;

    // Precompute Hann window & bit-reversal / twiddle tables for 1024-pt radix-2 FFT
    this.win = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.n - 1)));
    }
    this.bitrev = new Uint16Array(this.n);
    const bits = Math.log2(this.n);
    for (let i = 0; i < this.n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.bitrev[i] = r;
    }
    this.cosTab = new Float32Array(this.n / 2);
    this.sinTab = new Float32Array(this.n / 2);
    for (let i = 0; i < this.n / 2; i++) {
      const ang = (-2 * Math.PI * i) / this.n;
      this.cosTab[i] = Math.cos(ang);
      this.sinTab[i] = Math.sin(ang);
    }

    this.re = new Float32Array(this.n);
    this.im = new Float32Array(this.n);
    this.prevMag = new Float32Array(this.n / 2);

    this.ring = new Float32Array(this.n * 8);
    this.ringLen = 0;
    this.bufStart = 0;

    this.env = [];
    this.low = [];
    this.times = [];
    this.frames = 0;

    // Output state
    this.period = 0;
    this.ref = 0;
    this.conf = 0;
    this.refIndex = 0;
    this.downSlot = 0;
    this.slot = [0, 0, 0, 0];
    this.lastSlotBeat = -1e9;
    this.miss = 0;
    this.level = 0;
    this.peak = 1e-4;
    this.quietSince = 0;
    this.lastAudio = 0;
    this.relockUntil = 0;
  }

  get fps() {
    return this.sr / this.hop;
  }

  get audible() {
    return this.quietSince === 0 && Date.now() / 1000 - this.lastAudio < 1.2;
  }

  get energy() {
    return Math.min(1, this.level / Math.max(this.peak, 1e-4));
  }

  setSampleRate(sr) {
    if (sr > 8000 && Math.abs(sr - this.sr) > 1) {
      this.sr = sr;
      this.ringLen = 0;
    }
  }

  resetBeat(nowSec = Date.now() / 1000) {
    this.relockUntil = nowSec + 8;
    this.slot = [0, 0, 0, 0];
    this.lastSlotBeat = -1e9;
  }

  clearSilence() {
    this.level = 0;
    this.quietSince = Date.now() / 1000;
  }

  // Feed mono Float32Array samples captured at epoch timestamp `epochSec` (start of chunk)
  feed(mono, epochSec = Date.now() / 1000, rate = this.sr) {
    if (rate !== this.sr) {
      this.sr = rate;
      this.ringLen = 0;
    }
    if (this.ringLen === 0 || Math.abs(this.bufStart + this.ringLen / this.sr - epochSec) > 0.12) {
      this.ringLen = 0;
      this.bufStart = epochSec;
    }
    if (this.ringLen + mono.length > this.ring.length) {
      const next = new Float32Array(Math.max(this.ring.length * 2, this.ringLen + mono.length));
      next.set(this.ring.subarray(0, this.ringLen));
      this.ring = next;
    }
    this.ring.set(mono, this.ringLen);
    this.ringLen += mono.length;
    this.lastAudio = Date.now() / 1000;

    let consumed = 0;
    while (this.ringLen - consumed >= this.n) {
      this._processFrame(this.ring.subarray(consumed, consumed + this.n), this.bufStart + consumed / this.sr);
      consumed += this.hop;
    }
    if (consumed > 0) {
      const rem = this.ringLen - consumed;
      this.ring.copyWithin(0, consumed, this.ringLen);
      this.ringLen = rem;
      this.bufStart += consumed / this.sr;
    }
  }

  _fft() {
    const n = this.n;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < n; i++) {
      const j = this.bitrev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = this.cosTab[k];
          const wi = this.sinTab[k];
          const a = i + j;
          const b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  _processFrame(frame, startSec) {
    const n = this.n;
    const re = this.re;
    const im = this.im;
    const win = this.win;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = frame[i];
      re[i] = s * win[i];
      im[i] = 0;
      if (i < this.hop) sumSq += s * s;
    }
    this._fft();

    let fl = 0, fm = 0, fh = 0;
    const binHz = this.sr / n;
    const half = n >> 1;
    const prev = this.prevMag;
    for (let k = 1; k < half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const m = Math.log1p((1000 * mag) / n);
      const d = m > prev[k] ? m - prev[k] : 0;
      prev[k] = m;
      const f = k * binHz;
      if (f < 150) fl += d;
      else if (f < 2500) fm += d;
      else if (f < 11000) fh += d;
    }

    const rms = Math.sqrt(sumSq / this.hop);
    this.level = this.level * 0.96 + rms * 0.04;
    this.peak = Math.max(this.level, this.peak * 0.9995);
    const now = startSec + n / 2 / this.sr;
    if (this.level < 2e-4) {
      if (this.quietSince === 0) this.quietSince = now;
    } else {
      this.quietSince = 0;
    }

    this.env.push(fl * 1.6 + fm + fh * 0.6);
    this.low.push(fl);
    this.times.push(now);
    if (this.env.length > this.cap) {
      const cut = this.env.length - this.cap;
      this.env.splice(0, cut);
      this.low.splice(0, cut);
      this.times.splice(0, cut);
    }

    this.frames++;
    if (this.frames % 24 === 0) {
      this._estimate(now);
    }
  }

  _estimate(nowSec) {
    const W = Math.min(this.env.length, 800);
    if (W < 300) return;
    const base = this.env.length - W;
    const o = new Float64Array(W);
    for (let i = 0; i < W; i++) {
      let s = 0, c = 0;
      const a = Math.max(0, i - 8);
      const b = Math.min(W - 1, i + 8);
      for (let j = a; j <= b; j++) {
        s += this.env[base + j];
        c++;
      }
      const v = this.env[base + i] - s / c;
      o[i] = v > 0 ? v : 0;
    }

    const fps = this.fps;
    const lmin = Math.floor((fps * 60) / 180);
    const lmax = Math.floor((fps * 60) / 62);
    const acCache = new Float64Array(lmax * 2 + 4).fill(-1);
    const ac = (L) => {
      if (L < 0 || L >= W) return 0;
      if (L < acCache.length && acCache[L] >= 0) return acCache[L];
      let s = 0;
      for (let i = L; i < W; i++) s += o[i] * o[i - L];
      const v = s / (W - L);
      if (L < acCache.length) acCache[L] = v;
      return v;
    };
    const acf = (x) => {
      const a = Math.floor(x);
      const f = x - a;
      return ac(a) * (1 - f) + ac(a + 1) * f;
    };

    const r0 = Math.max(1e-9, ac(0));
    let best = lmin;
    let bestS = -1;
    const scores = new Float64Array(lmax + 2);
    const curBpm = this.period > 0 ? 60 / this.period : 0;

    for (let L = lmin; L <= lmax; L++) {
      const bpm = (60 * fps) / L;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.85, 2));
      let s = ac(L) + 0.35 * Math.max(0, acf(L / 2));
      if (2 * L < W / 2) s += 0.5 * ac(2 * L);
      scores[L] = s;
      const keep = curBpm > 0 ? 1 + 0.8 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / curBpm) / 0.025, 2)) : 1;
      const total = s * prior * keep;
      if (total > bestS) {
        bestS = total;
        best = L;
      }
    }

    let Lf = best;
    if (best > lmin && best < lmax) {
      const a = scores[best - 1], b = scores[best], c = scores[best + 1];
      const d = a - 2 * b + c;
      if (d < 0) Lf += (0.5 * (a - c)) / d;
    }

    const confNow = Math.min(1, ac(best) / r0);
    const P = Lf;
    let bestPh = 0;
    let bestV = -1;
    const maxPh = Math.ceil(P);
    for (let ph = 0; ph < maxPh; ph++) {
      let v = 0, w = 1, k = 0;
      while (true) {
        const idx = W - 1 - ph - k * P;
        if (idx < 1) break;
        const i0 = Math.floor(idx);
        const f = idx - i0;
        v += w * (o[i0] * (1 - f) + o[Math.min(W - 1, i0 + 1)] * f);
        w *= 0.93;
        k++;
      }
      if (v > bestV) {
        bestV = v;
        bestPh = ph;
      }
    }

    const tm = this.times[base + W - 1 - bestPh];
    const T = P / fps;
    if (this.period === 0 || confNow < 0.05) {
      if (confNow >= 0.08) {
        this.period = T;
        this.ref = tm;
        this.refIndex = 0;
        this.miss = 0;
      }
      this.conf = confNow;
      return;
    }

    const k = Math.round((tm - this.ref) / this.period);
    const pred = this.ref + k * this.period;
    const err = tm - pred;
    const sameTempo = Math.abs(T / this.period - 1) < 0.06;
    if (Math.abs(err) < this.period * 0.22 && sameTempo) {
      this.ref = pred + err * 0.25;
      this.refIndex += k;
      this.period = this.period * 0.85 + T * 0.15;
      this.miss = 0;
    } else {
      this.miss++;
      const thresh = nowSec < this.relockUntil ? 3 : 24;
      if (this.miss >= thresh) {
        this.period = T;
        this.ref = tm;
        this.refIndex = 0;
        this.slot = [0, 0, 0, 0];
        this.lastSlotBeat = -1e9;
        this.miss = 0;
      }
    }
    this.conf = this.conf * 0.6 + confNow * 0.4;

    // 4-beat bar downbeat estimation from low-band energy
    const firstT = this.times[base];
    const lastT = this.times[this.times.length - 1];
    let bi = Math.ceil((firstT - this.ref) / this.period) + this.refIndex;
    while (true) {
      const bt = this.ref + (bi - this.refIndex) * this.period;
      if (bt > lastT - 0.1) break;
      if (bi > this.lastSlotBeat) {
        let s = 0;
        for (let i = 0; i < this.env.length; i++) {
          if (Math.abs(this.times[i] - bt) < this.period / 6) s += this.low[i];
        }
        const sl = ((bi % 4) + 4) % 4;
        for (let j = 0; j < 4; j++) this.slot[j] *= 0.985;
        this.slot[sl] += s;
        this.lastSlotBeat = bi;
      }
      bi++;
    }

    let bestSlot = this.downSlot;
    let bv = -1;
    for (let s = 0; s < 4; s++) {
      const v = this.slot[s] + 0.6 * this.slot[(s + 2) % 4];
      if (v > bv) {
        bv = v;
        bestSlot = s;
      }
    }
    const curV = this.slot[this.downSlot] + 0.6 * this.slot[(this.downSlot + 2) % 4];
    if (bestSlot !== this.downSlot && bv > curV * 1.2) {
      this.downSlot = bestSlot;
    }
  }

  downbeatRef() {
    if (!(this.period > 0)) return 0;
    const off = (((this.downSlot - this.refIndex) % 4) + 4) % 4;
    return this.ref + off * this.period - 4 * this.period;
  }

  snapshot() {
    return {
      bpm: this.period > 0 ? 60 / this.period : 0,
      periodMs: this.period * 1000,
      beatRef: this.ref * 1000,
      downbeatRef: this.downbeatRef() * 1000,
      conf: this.conf,
      energy: this.energy,
      audible: this.audible
    };
  }
}

// Self-test when executed directly: generates a synthetic 128 BPM 4/4 kick+snare+hihat signal
if (import.meta.url === `file://${process.argv[1]}`) {
  const sr = 48000;
  const bpm = 128;
  const spb = 60 / bpm;
  const totalSec = 18;
  const ana = new BeatAnalyzer();
  const chunk = 512;
  const t0 = 1700000000;
  for (let i = 0; i < totalSec * sr; i += chunk) {
    const mono = new Float32Array(chunk);
    for (let k = 0; k < chunk; k++) {
      const t = (i + k) / sr;
      const beat = t / spb;
      const bi = Math.floor(beat);
      const frac = (beat - bi) * spb;
      let v = 0;
      // Kick on every beat, heavier on beat 1 of 4
      if (frac < 0.12) {
        const amp = bi % 4 === 0 ? 0.95 : 0.65;
        const freq = 140 * Math.exp(-frac * 28) + 45;
        v += amp * Math.sin(2 * Math.PI * freq * frac) * Math.exp(-frac * 22);
      }
      // Hi-hat on off-beats
      const hf = ((beat * 2) % 1) * (spb / 2);
      if (hf < 0.03) {
        v += 0.25 * (Math.sin(t * 19317) + Math.sin(t * 27911)) * Math.exp(-hf * 90);
      }
      mono[k] = v;
    }
    ana.feed(mono, t0 + i / sr, sr);
  }
  const snap = ana.snapshot();
  const phaseErrMs = Math.abs((((snap.beatRef / 1000 - t0) % spb) + spb) % spb) * 1000;
  const errMs = Math.min(phaseErrMs, spb * 1000 - phaseErrMs);
  console.log(`Self-test 128 BPM -> measured=${snap.bpm.toFixed(2)} BPM, conf=${snap.conf.toFixed(2)}, phaseErr=${errMs.toFixed(1)} ms`);
  if (Math.abs(snap.bpm - 128) > 1.5 || errMs > 25) {
    process.exit(1);
  }
}
