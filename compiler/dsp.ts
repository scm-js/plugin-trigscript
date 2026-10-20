/**
 * What a clip goes through when the script is built (`sound.ts`'s `Clip` methods, and the music library's tracks): a
 * filter, saturation, an echo, a reverb, a chorus, a compressor — and the sources beside `tone`: a stack of detuned
 * voices, two-operator FM, a plucked string. Each works on channels of samples (−1 … 1) and gives new ones; nothing
 * here knows about clips. The game hears only what comes out: none of this costs it anything, only the build's time.
 *
 * Everything is the same on every build: noise and phases come from fixed seeds.
 */

export type Channels = readonly Float32Array[];

/** A value through time: [seconds, value] points, a straight line between them; the first before, the last after. */
export type Points = readonly (readonly [number, number])[];

/** Each sample's value from points (or one value throughout), in their own units or, with `log`, by ratios. */
export function curve(v: number | Points, rate: number, n: number, log = false): Float32Array {
  const out = new Float32Array(n);
  if (typeof v === "number") return out.fill(v);
  const ps = v.map(([t, x]) => [t * rate, log ? Math.log(x) : x] as const);
  for (let i = 0, k = 0; i < n; i++) {
    while (k < ps.length && ps[k][0] <= i) k++;
    const x = k === 0 ? ps[0][1] : k === ps.length ? ps[k - 1][1] : ps[k - 1][1] + ((ps[k][1] - ps[k - 1][1]) * (i - ps[k - 1][0])) / (ps[k][0] - ps[k - 1][0] || 1);
    out[i] = log ? Math.exp(x) : x;
  }
  return out;
}

/* ── Filters ── */

export type FilterType = "lowpass" | "highpass" | "bandpass" | "notch" | "lowshelf" | "highshelf" | "peak";

/**
 * A state-variable filter (the trapezoidal form: stable however fast its cutoff moves): lowpass, highpass, bandpass or
 * notch, its cutoff a frequency or points through time, `resonance` 0 (none, Q 0.5) to 1 (ringing at the cutoff).
 */
export function svf(chans: Channels, rate: number, type: "lowpass" | "highpass" | "bandpass" | "notch", cutoff: number | Points, resonance: number): Float32Array[] {
  const n = chans[0].length, hz = curve(cutoff, rate, n, true);
  const k = 2 - 1.96 * Math.max(0, Math.min(1, resonance));
  return chans.map((x) => {
    const out = new Float32Array(n);
    let ic1 = 0, ic2 = 0, lastHz = -1, a1 = 0, a2 = 0, a3 = 0, g = 0;
    for (let i = 0; i < n; i++) {
      const f = Math.min(hz[i], rate * 0.49);
      if (f !== lastHz) {
        lastHz = f;
        g = Math.tan((Math.PI * f) / rate);
        a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
      }
      const v0 = x[i], v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      out[i] = type === "lowpass" ? v2 : type === "highpass" ? v0 - k * v1 - v2 : type === "bandpass" ? v1 : v0 - k * v1;
    }
    return out;
  });
}

/** A shelf or a peak (the cookbook biquads): `gain` dB below or above `hz`, or around it, `q` wide (0.707). */
export function eq(chans: Channels, rate: number, type: "lowshelf" | "highshelf" | "peak", hz: number, gain: number, q = Math.SQRT1_2): Float32Array[] {
  const w = (2 * Math.PI * Math.min(hz, rate * 0.49)) / rate, cos = Math.cos(w), sin = Math.sin(w), A = 10 ** (gain / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === "peak") {
    const alpha = sin / (2 * q);
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else {
    const alpha = (sin / 2) * Math.sqrt(2), s = 2 * Math.sqrt(A) * alpha;
    [b0, b1, b2, a0, a1, a2] = type === "lowshelf"
      ? [A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s), A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s]
      : [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s), A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s];
  }
  return chans.map((x) => {
    const out = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y; out[i] = y;
    }
    return out;
  });
}

/* ── Saturation ── */

/**
 * Saturation: each sample through tanh after `dB` more gain, and the gain taken off again — a quiet part as it was, a
 * loud one rounded, more and more like a square. Worked at twice the rate (`up`, `down`: the clip's resampler), so the
 * harmonics it makes above half the rate do not fold back down.
 */
export function saturate(chans: Channels, dB: number, up: (s: Float32Array) => Float32Array, down: (s: Float32Array) => Float32Array): Float32Array[] {
  const g = 10 ** (dB / 20);
  return chans.map((x) => {
    const n = x.length, hi = up(x);
    for (let i = 0; i < hi.length; i++) hi[i] = Math.tanh(g * hi[i]) / g;
    const back = down(hi);
    return back.length === n ? back : Float32Array.from({ length: n }, (_, i) => back[i] ?? 0);
  });
}

/* ── Time ── */

/** A delay line read a whole or a fractional number of samples back; its length a power of two, so wrapping is a mask. */
class Line {
  private readonly buf: Float32Array;
  private readonly mask: number;
  private at = 0;
  constructor(size: number) {
    let n = 4;
    while (n < size + 2) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number): void { this.buf[this.at] = x; this.at = (this.at + 1) & this.mask; }
  /** `d` whole samples back (1 is the last written). */
  tap(d: number): number { return this.buf[(this.at - d) & this.mask]; }
  /** `d` samples back, between samples when `d` is not whole. */
  read(d: number): number {
    const p = this.at - d, i = Math.floor(p), f = p - i;
    const a = this.buf[i & this.mask];
    return a + (this.buf[(i + 1) & this.mask] - a) * f;
  }
}

/** Seconds until a repeat that falls by `feedback` each time is 60 dB down, at most `cap`. */
const tailOf = (feedback: number, every: number, cap: number) => Math.min(cap, feedback <= 0 ? every : every * Math.ceil(Math.log(0.001) / Math.log(Math.min(0.999, feedback))));
/** Samples an echo adds to a clip: its repeats until they are 60 dB down, 30 seconds at most. */
export const echoTail = (rate: number, seconds: number, feedback: number) => Math.round(tailOf(feedback, seconds, 30) * rate);

/**
 * An echo `seconds` after, each repeat `feedback` as loud and a little duller (a lowpass at `tone` Hz in the loop),
 * `mix` its level beside the clip. `pingPong`: the repeats go left, right, left — the clip then has two channels.
 */
export function echo(chans: Channels, rate: number, seconds: number, feedback: number, mix: number, tone: number, pingPong: boolean): Float32Array[] {
  const d = seconds * rate, n = chans[0].length, total = n + echoTail(rate, seconds, feedback);
  const ins = pingPong && chans.length === 1 ? [chans[0], chans[0]] : chans;
  const lp = Math.exp((-2 * Math.PI * tone) / rate);
  if (!pingPong) {
    return ins.map((x) => {
      const out = new Float32Array(total), line = new Line(d);
      let z = 0;
      for (let i = 0; i < total; i++) {
        const dry = i < n ? x[i] : 0, back = line.read(d);
        z = back + (z - back) * lp;
        line.write(dry + z * feedback);
        out[i] = dry + back * mix;
      }
      return out;
    });
  }
  // Ping-pong: what goes in is heard left first, and each line feeds the other.
  const [l, r] = ins, L = new Float32Array(total), R = new Float32Array(total), a = new Line(d), b = new Line(d);
  let za = 0, zb = 0;
  for (let i = 0; i < total; i++) {
    const dl = i < n ? l[i] : 0, dr = i < n ? r[i] : 0, ba = a.read(d), bb = b.read(d);
    za = ba + (za - ba) * lp; zb = bb + (zb - bb) * lp;
    a.write((dl + dr) / 2 + zb * feedback);
    b.write(za * feedback);
    L[i] = dl + ba * mix; R[i] = dr + bb * mix;
  }
  return [L, R];
}

/**
 * A plate reverb (after Dattorro's, 1997): the clip, summed to one, through a pre-delay, a little top cut and four
 * diffusers into a figure-eight tank of two halves, each a wobbling allpass, a delay, damping, the decay and another
 * allpass and delay, feeding the other; left and right are read from seven taps across the tank each, so the two are
 * different rooms' worth of the same sound. `decay` 0 … 1 (0.5 a room, 0.9 a hall), `damping` 0 … 1 (how fast the top
 * dies), `predelay` seconds, `mix` the reverb's level, `dry` the clip's. Two channels, `tail` samples longer than the
 * clip (`plateTail`), the last 50 ms of them faded out.
 */
export function plate(chans: Channels, rate: number, o: { decay: number; damping: number; predelay: number; mix: number; dry: number; width: number }, tail: number): Float32Array[] {
  const s = rate / 29761, n = chans[0].length;
  const len = (x: number) => Math.round(x * s);
  const preTap = Math.max(1, Math.round(o.predelay * rate)), pre = new Line(preTap + 1);
  const diffusers = [[142, 0.75], [107, 0.75], [379, 0.625], [277, 0.625]].map(([d, g]) => ({ line: new Line(len(d)), d: len(d), g }));
  const half = (ap1: number, d1: number, ap2: number, d2: number) => ({
    ap1: new Line(len(ap1) + len(16) + 2), ap1d: len(ap1), d1: new Line(len(d1)), d1n: len(d1),
    ap2: new Line(len(ap2)), ap2d: len(ap2), d2: new Line(len(d2)), d2n: len(d2), damp: 0,
  });
  const A = half(672, 4453, 1800, 3720), B = half(908, 4217, 2656, 3163);
  const decay = Math.max(0, Math.min(0.97, o.decay)), damping = Math.max(0, Math.min(0.99, o.damping)), bw = 0.9995;
  const excursion = len(16), lfo = (2 * Math.PI * 1.0) / rate;
  // The output taps (Dattorro's table), left then right.
  const T = [266, 2974, 1913, 1996, 1990, 187, 1066, 353, 3627, 1228, 2673, 2111, 335, 121].map((d) => Math.max(1, len(d)));
  const cap = n + tail, fadeFrom = cap - Math.min(tail, Math.round(0.05 * rate));
  const L = new Float32Array(cap), R = new Float32Array(cap);
// The two halves of the tank, each fed by the other's end.
  const run = (h: typeof A, input: number, phase: number, at: number) => {
    const md = h.ap1d + excursion * Math.sin(lfo * at + phase);
    const back1 = h.ap1.read(md), w1 = input + 0.7 * back1;
    h.ap1.write(w1);
    const y1 = back1 - 0.7 * w1;
    h.d1.write(y1);
    const d1 = h.d1.tap(h.d1n);
    h.damp = (1 - damping) * d1 + damping * h.damp;
    const into = h.damp * decay;
    const back2 = h.ap2.tap(h.ap2d), w2 = into - 0.5 * back2;
    h.ap2.write(w2);
    h.d2.write(back2 + 0.5 * w2);
    return h.d2.tap(h.d2n) * decay;
  };
  let band = 0, lastA = 0, lastB = 0;
  for (let i = 0; i < cap; i++) {
    let x = 0;
    if (i < n) { for (const c of chans) x += c[i]; x /= chans.length; }
    pre.write(x);
    let v = pre.tap(preTap);
    band = bw * v + (1 - bw) * band;
    v = band;
    for (const ap of diffusers) {
      const back = ap.line.tap(ap.d), w = v - ap.g * back;
      ap.line.write(w);
      v = back + ap.g * w;
    }
    const outA = run(A, v + lastB, 0, i), outB = run(B, v + lastA, Math.PI / 2, i);
    lastA = outA; lastB = outB;
    const yl = B.d1.tap(T[0]) + B.d1.tap(T[1]) - B.ap2.tap(T[2]) + B.d2.tap(T[3]) - A.d1.tap(T[4]) - A.ap2.tap(T[5]) - A.d2.tap(T[6]);
    const yr = A.d1.tap(T[7]) + A.d1.tap(T[8]) - A.ap2.tap(T[9]) + A.d2.tap(T[10]) - B.d1.tap(T[11]) - B.ap2.tap(T[12]) - B.d2.tap(T[13]);
    const mid = (yl + yr) / 2, side = ((yl - yr) / 2) * o.width;
    const wl = 0.6 * o.mix * (mid + side), wr = 0.6 * o.mix * (mid - side);
    const dl = i < n ? chans[0][i] : 0, dr = i < n ? chans[chans.length - 1][i] : 0;
    const out = i < fadeFrom ? 1 : (cap - i) / (cap - fadeFrom);
    L[i] = (o.dry * dl + wl) * out; R[i] = (o.dry * dr + wr) * out;
  }
  return [L, R];
}

/**
 * How long a plate's tail lasts, in seconds: until a sound has gone round the tank enough times to be 60 dB down. A
 * half of the tank is 0.36 s (its delays at Dattorro's rate) and takes `decay` off twice: 1.24 / −ln(decay) seconds,
 * 12 at most, after the pre-delay.
 */
export const plateTail = (decay: number, predelay: number) => predelay + Math.min(12, 1.24 / -Math.log(Math.max(0.01, Math.min(0.97, decay))));

/** A chorus: the clip beside copies of itself a few milliseconds late and wobbling, left and right out of step. Two channels. */
export function chorus(chans: Channels, rate: number, speed: number, depth: number, mix: number): Float32Array[] {
  const n = chans[0].length, base = 0.012 * rate, swing = depth * rate, w = (2 * Math.PI * speed) / rate;
  const ins = chans.length === 1 ? [chans[0], chans[0]] : chans;
  return ins.map((x, side) => {
    const out = new Float32Array(n), line = new Line(base + swing + 2);
    for (let i = 0; i < n; i++) {
      line.write(x[i]);
      const wet = line.read(base + swing * Math.sin(w * i + side * (Math.PI / 2)));
      out[i] = (1 - mix) * x[i] + mix * wet;
    }
    return out;
  });
}

/**
 * A compressor: above `threshold` dB, every `ratio` dB in is one out, eased over a `knee` dB wide; turning down over
 * `attack` seconds, back up over `release`; both sides by the louder; `makeup` dB after.
 */
export function compressor(chans: Channels, rate: number, o: { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }): Float32Array[] {
  const n = chans[0].length, att = Math.exp(-1 / Math.max(1, o.attack * rate)), rel = Math.exp(-1 / Math.max(1, o.release * rate));
  const gain = new Float32Array(n), slope = 1 - 1 / o.ratio, k = Math.max(0, o.knee);
  let env = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const c of chans) m = Math.max(m, Math.abs(c[i]));
    const level = 20 * Math.log10(Math.max(m, 1e-9)), over = level - o.threshold;
    const reduce = k > 0 && Math.abs(over) <= k / 2 ? (slope * (over + k / 2) ** 2) / (2 * k) : over > 0 ? slope * over : 0;
    env = reduce > env ? att * env + (1 - att) * reduce : rel * env + (1 - rel) * reduce;
    gain[i] = 10 ** ((o.makeup - env) / 20);
  }
  return chans.map((c) => { const out = new Float32Array(c.length); for (let i = 0; i < c.length; i++) out[i] = c[i] * gain[i]; return out; });
}

/* ── Sources ── */

/** A fixed sequence of numbers 0 … 1 from a seed: the same on every build. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/**
 * Two-operator FM: a sine whose phase is pushed by another sine `ratio` times its pitch, `index` how far (points
 * through time, for a bright start that mellows), `feedback` the modulator fed its own output (a saw-like edge).
 */
export function fmVoice(hz: Float32Array, rate: number, ratio: number, index: Float32Array, feedback: number): Float32Array {
  const n = hz.length, out = new Float32Array(n);
  let pc = 0, pm = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.sin(2 * Math.PI * pm + feedback * last);
    last = m;
    out[i] = Math.sin(2 * Math.PI * pc + index[i] * m);
    pc += hz[i] / rate; pm += (hz[i] * ratio) / rate;
    pc -= Math.floor(pc); pm -= Math.floor(pm);
  }
  return out;
}

/**
 * A plucked string (Karplus–Strong): a burst of noise in a loop one period long, averaged as it goes round so the top
 * dies first. `brightness` 0 … 1 how much of the top the burst has and the loop keeps; `decay` seconds to fade 60 dB.
 */
export function pluckVoice(hz: number, rate: number, n: number, brightness: number, decay: number): Float32Array {
  const period = rate / hz, out = new Float32Array(n), random = seeded(Math.round(hz * 1000));
  // The averaging delays half a sample as much as it averages: the loop is that much shorter, the rest a fraction
  // read between samples.
  const keep = 0.5 + 0.5 * brightness;
  const line = new Line(period + 2), p = Math.max(2, period - 0.5 * (1 - keep));
  let lp = 0;
  const burstLp = 0.15 + 0.85 * brightness;
  for (let i = 0; i < Math.ceil(period) + 2; i++) { lp += burstLp * (random() * 2 - 1 - lp); line.write(lp); }
  // Loss a round so the note is 60 dB down after `decay` seconds.
  const rounds = (decay * rate) / period, loss = Math.pow(0.001, 1 / Math.max(1, rounds));
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = line.read(p);
    const y = loss * (keep * x + (1 - keep) * ((x + prev) / 2));
    prev = x;
    line.write(y);
    out[i] = x;
  }
  return out;
}
