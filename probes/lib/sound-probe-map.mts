// The sound probe's map (probes/sound-probe.ts): a base map with the probe's sounds in its archive, each made here so
// that a recording's audio says which one played and when — every sound a pure tone or click of its own.
//
//   npx tsx probes/lib/raycaster-map.mts fixtures/eud/sound-base.scx
//   npx tsx probes/lib/sound-probe-map.mts fixtures/eud/sound-base.scx fixtures/eud/sound-probe-base.scx
//
// What it puts in staredit\wav\ (16-bit mono 22 050 Hz WAV unless said, all in the map's WAV list but one):
//   probe-click.wav           a 4 ms burst at 2 kHz: the timing tests' tick
//   probe-click-unlisted.wav  the same at 3 kHz, NOT in the WAV list: whether a sound the list does not name starts late
//   probe-sweep.wav           1 s falling from 2 000 to 500 Hz: whether playing it again restarts it or adds a second one
//   probe-tone-00 … 31.wav    6 s each, 300 + 45·k Hz: how many sounds play at once
//   probe-same.wav            2 s at 700 Hz: one copy, then eight in the same frame
//   probe-loud.wav / -quiet   1 s at 880 Hz, at 0.8 and at 0.2 (−12 dB): whether the game evens out loudness
//   probe-fmt-*               1 s each, a pitch a format: 8-bit 11 kHz (500 Hz), 8-bit 22 kHz (600), 16-bit 22 kHz
//                             (700), 16-bit 44 kHz stereo (800), 16-bit 48 kHz (900), IMA ADPCM 22 kHz (1 000),
//                             Ogg Vorbis 44 kHz (1 100), Ogg Opus 48 kHz (1 200)
// Needs ffmpeg (with libvorbis and libopus) for the Ogg and ADPCM ones, and a scm-js checkout beside this one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E = process.env.SCMJS_DIR ?? join(import.meta.dirname, "..", "..", "..", "scm-js");
const { loadMap, saveMap, readExtras } = await import(join(E, "src/formats/mpq/scm.ts"));
const { parseScenario, serializeScenario } = await import(join(E, "src/formats/chk/scenario.ts"));
const { addSound, applySounds, readWavs } = await import(join(E, "src/editor/sounds.ts"));

const [base, out] = process.argv.slice(2);
if (!base || !out) { console.error("usage: sound-probe-map.mts <base.scx> <out.scx>"); process.exit(2); }

/** A WAV of PCM samples (−1 … 1 floats per channel, interleaved), 8 or 16 bits. */
function wav(samples: Float32Array, rate: number, bits: 8 | 16 = 16, channels = 1): Uint8Array {
  const bytes = bits / 8, data = samples.length * bytes, out = new Uint8Array(44 + data), v = new DataView(out.buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, "RIFF"); v.setUint32(4, 36 + data, true); text(8, "WAVE"); text(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytes, true); v.setUint16(32, channels * bytes, true); v.setUint16(34, bits, true);
  text(36, "data"); v.setUint32(40, data, true);
  samples.forEach((s, i) => {
    const c = Math.max(-1, Math.min(1, s));
    if (bits === 16) v.setInt16(44 + i * 2, Math.round(c * 32767), true); else out[44 + i] = Math.round(128 + c * 127);
  });
  return out;
}

/** A tone: `seconds` long at `hz`, `amplitude` peak, 5 ms in and out so it does not click. */
function tone(hz: number | ((t: number) => number), seconds: number, amplitude: number, rate: number, channels = 1): Float32Array {
  const n = Math.round(seconds * rate), s = new Float32Array(n * channels);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, f = typeof hz === "number" ? hz : hz(t);
    phase += (2 * Math.PI * f) / rate;
    const ramp = Math.min(1, t / 0.005, (seconds - t) / 0.005);
    for (let c = 0; c < channels; c++) s[i * channels + c] = amplitude * ramp * Math.sin(phase);
  }
  return s;
}

/** A click: a 4 ms burst of `hz`, its first sample at full height, then silence to 40 ms. */
function click(hz: number, rate: number): Float32Array {
  const s = new Float32Array(Math.round(0.04 * rate));
  for (let i = 0; i < 0.004 * rate; i++) s[i] = 0.9 * Math.cos((2 * Math.PI * hz * i) / rate) * (1 - i / (0.004 * rate));
  return s;
}

/** Through ffmpeg: a WAV in, the format asked for out. */
function ffmpeg(input: Uint8Array, args: string[], ext: string): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "sound-probe-"));
  try {
    writeFileSync(join(dir, "in.wav"), input);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "in.wav"), ...args, join(dir, `out.${ext}`)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`);
    return new Uint8Array(readFileSync(join(dir, `out.${ext}`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const R = 22050;
const sounds = new Map<string, Uint8Array>([
  ["probe-click.wav", wav(click(2000, R), R)],
  ["probe-click-unlisted.wav", wav(click(3000, R), R)],
  ["probe-sweep.wav", wav(tone((t) => 2000 - 1500 * t, 1, 0.5, R), R)],
  ...Array.from({ length: 32 }, (_, k) => [`probe-tone-${String(k).padStart(2, "0")}.wav`, wav(tone(300 + 45 * k, 6, 0.2, R), R)] as [string, Uint8Array]),
  ["probe-same.wav", wav(tone(700, 2, 0.1, R), R)],
  ["probe-loud.wav", wav(tone(880, 1, 0.8, R), R)],
  ["probe-quiet.wav", wav(tone(880, 1, 0.2, R), R)],
  ["probe-fmt-8-11k.wav", wav(tone(500, 1, 0.5, 11025), 11025, 8)],
  ["probe-fmt-8-22k.wav", wav(tone(600, 1, 0.5, R), R, 8)],
  ["probe-fmt-16-22k.wav", wav(tone(700, 1, 0.5, R), R)],
  ["probe-fmt-16-44k-stereo.wav", wav(tone(800, 1, 0.5, 44100, 2), 44100, 16, 2)],
  ["probe-fmt-16-48k.wav", wav(tone(900, 1, 0.5, 48000), 48000)],
  ["probe-fmt-ima-22k.wav", ffmpeg(wav(tone(1000, 1, 0.5, R), R), ["-c:a", "adpcm_ima_wav"], "wav")],
  ["probe-fmt-vorbis-44k.ogg", ffmpeg(wav(tone(1100, 1, 0.5, 44100), 44100), ["-c:a", "libvorbis", "-q:a", "4"], "ogg")],
  ["probe-fmt-opus-48k.ogg", ffmpeg(wav(tone(1200, 1, 0.5, 48000), 48000), ["-c:a", "libopus", "-b:a", "96k"], "ogg")],
]);

const loaded = await loadMap(new Uint8Array(readFileSync(base)));
const scn = parseScenario(loaded.chk);
const extras = new Map<string, Uint8Array>(loaded.archive ? await readExtras(loaded.archive, loaded.files) : []);
const wavs = readWavs(scn);
for (const [name, bytes] of sounds) {
  const path = `staredit\\wav\\${name}`;
  extras.set(path, bytes);
  if (name !== "probe-click-unlisted.wav") addSound(scn, wavs, path);
}
// (internString and applySounds mark STR and WAV for the save.)
applySounds(scn, wavs);
writeFileSync(out, await saveMap(serializeScenario(scn), { extras, compress: "pkware", listfile: true }));
console.log(`${sounds.size} sounds, ${[...sounds.values()].reduce((s, b) => s + b.length, 0)} bytes, ${wavs.filter((w: number) => w).length} in the WAV list`);
