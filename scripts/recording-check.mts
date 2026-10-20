/**
 * A recording of a probe played in StarCraft: Remastered, checked against the sounds that went in
 * (`scripts/sound-dump.mts`): where each starts, how far apart, whether it drifts, how loud against the file, how close
 * below and above 6 kHz, the worst second, the sides, the peaks — and, for a song the game plays piece by piece, when
 * each piece starts against the song played through.
 *
 *   npx tsx scripts/recording-check.mts "/mnt/c/Users/…/StarCraft 2026.10.19 - 16.56.34.39.mp4" a.ogg b.ogg
 *   npx tsx scripts/recording-check.mts rec.mp4 playthrough.ogg --pieces=1.68
 *
 * The references are found in the recording in the order given, each after the one before. The game's audio is
 * digital silence between sounds, so a sound's start is readable to the sample; the recording's own coding (AAC) blurs
 * the top — 9 to 10 dB above 6 kHz is the recorder, not the game. Needs ffmpeg.
 */
import { spawnSync } from "node:child_process";

const R = 48000;
const args = process.argv.slice(2);
const pieces = Number(args.find((a) => a.startsWith("--pieces="))?.split("=")[1] ?? 0);
const [recording, ...refs] = args.filter((a) => !a.startsWith("--"));
if (!recording || refs.length === 0) { console.error("usage: recording-check <recording> <ref.ogg>… [--pieces=<seconds>]"); process.exit(2); }

/** A file's sound as 48 kHz, two channels, interleaved. */
function decode(path: string): Float32Array {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", String(R), "-f", "f32le", "-"], { maxBuffer: 2 ** 31 });
  if (out.status !== 0) throw new Error(`ffmpeg could not read ${path}: ${out.stderr.toString()}`);
  const b = out.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const db = (x: number) => 10 * Math.log10(x + 1e-20);
const rec = decode(recording), n = rec.length / 2;

// Where sound starts after silence: the first sample over 0.01 after 0.5 s under 0.003.
const onsets: number[] = [];
{
  // Armed by half a second under 0.003; what is between the two (a fade's start) neither starts nor disarms.
  let quiet = R, armed = true;
  for (let i = 0; i < n; i++) {
    const loud = Math.max(Math.abs(rec[2 * i]), Math.abs(rec[2 * i + 1]));
    quiet = loud < 0.003 ? quiet + 1 : 0;
    if (quiet >= R / 2) armed = true;
    if (loud > 0.01 && armed) { onsets.push(i); armed = false; }
  }
}
console.log(`${recording}: ${(n / R).toFixed(1)} s; sound starts at ${onsets.map((o) => (o / R).toFixed(3)).join(", ")} s`);

/** Correlation of the recording from `at` with `ref` from `from`, over `len` frames, both channels. */
function corr(ref: Float32Array, at: number, from: number, len: number): number {
  let s = 0, a = 0, b = 0;
  for (let i = 0; i < len; i++) for (let c = 0; c < 2; c++) { const x = rec[2 * (at + i) + c] ?? 0, y = ref[2 * (from + i) + c] ?? 0; s += x * y; a += x * x; b += y * y; }
  return s / Math.sqrt(a * b + 1e-20);
}
/** The lag (frames) within ±`span` of `at` where `ref` from `from` fits best. */
function fit(ref: Float32Array, at: number, from: number, len: number, span: number): { lag: number; c: number } {
  let best = { lag: 0, c: -2 };
  for (let k = -span; k <= span; k += 8) { const c = corr(ref, at + k, from, len); if (c > best.c) best = { lag: k, c }; }
  for (let k = best.lag - 8; k <= best.lag + 8; k++) { const c = corr(ref, at + k, from, len); if (c > best.c) best = { lag: k, c }; }
  return best;
}

let after = 0, previous = -1;
for (const path of refs) {
  const ref = decode(path), m0 = ref.length / 2;
  let first = 0;
  while (first < m0 && Math.abs(ref[2 * first]) < 0.01 && Math.abs(ref[2 * first + 1]) < 0.01) first++;
  // The first onset after the last reference's where its first two seconds fit (0.8), or else the one they fit best.
  let start = -1, best = -2;
  for (const o of onsets.filter((x) => x >= after)) {
    const f = fit(ref, o - first, 0, Math.min(2 * R, m0), 480);
    if (f.c > best) { best = f.c; start = o - first + f.lag; }
    if (f.c >= 0.8) break;
  }
  if (start < 0) { console.log(`\n${path}: not found after ${(after / R).toFixed(1)} s`); continue; }
  const m = Math.min(m0, n - start);
  let ee = 0, rr = 0, peak = 0, full = 0;
  for (let i = 0; i < m; i++) for (let c = 0; c < 2; c++) { const y = ref[2 * i + c], x = rec[2 * (start + i) + c]; ee += y * y; rr += x * x; const a = Math.abs(x); if (a > peak) peak = a; if (a >= 0.999) full++; }
  const gain = Math.sqrt(rr / ee);
  // Drift: the lag of each ten seconds, fitted again.
  const lags: number[] = [];
  for (let t = 2 * R; t + R < m; t += 10 * R) lags.push(fit(ref, start + t, t, R, 240).lag);
  // Second by second: level against the file, and how close (below 6 kHz, above, all).
  const a6 = 1 - Math.exp((-2 * Math.PI * 6000) / R);
  let lo = 0, loE = 0, hi = 0, hiE = 0, worst = Infinity, worstAt = 0, level = [Infinity, -Infinity];
  const s1 = [0, 0], s2 = [0, 0];
  for (let sec = 0; (sec + 1) * R <= m; sec++) {
    let a = 0, b = 0, e = 0;
    for (let i = sec * R; i < (sec + 1) * R; i++) for (let c = 0; c < 2; c++) {
      const y = ref[2 * i + c] * gain, x = rec[2 * (start + i) + c];
      s1[c] += a6 * (y - s1[c]); s2[c] += a6 * (x - s2[c]);
      lo += s1[c] ** 2; loE += (s2[c] - s1[c]) ** 2; hi += (y - s1[c]) ** 2; hiE += (x - s2[c] - (y - s1[c])) ** 2;
      a += y * y; b += x * x; e += (x - y) ** 2;
    }
    if (a / (2 * R) < 1e-7) continue;
    const d = db(b / a);
    level = [Math.min(level[0], d), Math.max(level[1], d)];
    if (db(a / e) < worst) { worst = db(a / e); worstAt = sec; }
  }
  let side = 0, sideR = 0, sideE = 0;
  for (let i = 0; i < m; i++) { const x = rec[2 * (start + i)] - rec[2 * (start + i) + 1], y = ref[2 * i] - ref[2 * i + 1]; side += x * y; sideR += x * x; sideE += y * y; }
  console.log(`\n${path} (${(m0 / R).toFixed(2)} s, compared ${(m / R).toFixed(1)} s)`);
  console.log(`  starts at ${(start / R).toFixed(4)} s${previous >= 0 ? `, ${((start - previous) / R).toFixed(4)} s after the one before (${((start - previous) / R / 0.042).toFixed(1)} frames)` : ""}; fit ${best.toFixed(3)}`);
  console.log(`  heard ${db(gain * gain).toFixed(2)} dB against the file; each second ${level[0].toFixed(1)} … ${level[1].toFixed(1)} dB of that`);
  console.log(`  drift: the lag at every 10 s ${lags.join(", ")} frames of 48 kHz`);
  console.log(`  close: ${db(lo / loE).toFixed(1)} dB below 6 kHz, ${db(hi / hiE).toFixed(1)} above; the worst second ${worst.toFixed(1)} dB at ${worstAt} s`);
  console.log(`  sides: L − R follows the file's at ${(side / Math.sqrt(sideR * sideE + 1e-20)).toFixed(3)}; peak ${peak.toFixed(3)}, ${full} samples at full scale`);
  if (pieces > 0) {
    const rows: string[] = [], good: number[] = [];
    for (let g = 0; (g + 0.3) * pieces * R < m; g++) {
      const at = Math.round(g * pieces * R), f = fit(ref, start + at, at, Math.round(Math.min(0.35, pieces * 0.8) * R), 1440);
      rows.push(`${g}:${(f.lag / 48).toFixed(1)}`);
      if (f.c > 0.5) good.push(f.lag / 48);
    }
    const mean = good.reduce((a, b) => a + b, 0) / good.length, sd = Math.sqrt(good.reduce((a, b) => a + (b - mean) ** 2, 0) / good.length);
    console.log(`  pieces of ${pieces} s, each start's lag in ms: ${rows.join(" ")}`);
    console.log(`  ${good.length} of ${rows.length} clear: mean ${mean.toFixed(1)} ms, sd ${sd.toFixed(1)}, ${Math.min(...good).toFixed(1)} … ${Math.max(...good).toFixed(1)}`);
    console.log("  (played piece by piece, the sample match and the drift above follow each piece's start, and say little)");
  }
  after = start + Math.round(m0 * 0.9);
  previous = start;
}
