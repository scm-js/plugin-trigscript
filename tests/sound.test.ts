/**
 * Sounds a script imports or makes: the `.sound` format and its IMA ADPCM, what a `Clip` does when the script is built,
 * clips made from nothing, and a script whose program plays clips — each clip a WAV for the map's archive, once.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adpcmFidelity, adpcmWav, clipChannels, clipFile, periodicity, clipSamples, decodeAdpcm, describeSound, encodeAdpcm, hertz, LIMIT_CEILING, makeClip, mixdown, noise, readSound, silence, tone, writeSound } from "../compiler/sound";
import { finishSounds, vorbisEncoder } from "../compiler/vorbis";
import { describeMedia, isMediaFile } from "../compiler/media";
import { buildScript, isBuiltSound, readFiles, withFiles, withSounds } from "../script";

const LIB = defaultLib();
const sine = (hz: number, seconds: number, rate = 22050, amplitude = 0.5) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (a: Float32Array, b: Float32Array) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

describe("IMA ADPCM", () => {
  it("comes back close to what went in, at every rate", () => {
    for (const rate of [11025, 22050, 44100]) {
      const s = sine(440, 0.7, rate);
      const back = decodeAdpcm(encodeAdpcm(s, rate), rate, s.length);
      expect(back.length).toBe(s.length);
      expect(rms(s, back), `${rate}`).toBeLessThan(0.02);
    }
  });

  it("writes a WAV the game reads: format 0x11, a block size, its samples a block, the count in fact", () => {
    const s = sine(440, 0.1);
    const wav = adpcmWav(encodeAdpcm(s, 22050), 22050, s.length), v = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(40), tag(52)]).toEqual(["RIFF", "WAVE", "fmt ", "fact", "data"]);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(32, true), v.getUint16(34, true), v.getUint16(38, true), v.getUint32(48, true)]).toEqual([0x11, 1, 22050, 512, 4, 1017, s.length]);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
  });
});

describe("the .sound format", () => {
  it("reads back its rate, length, source and samples", () => {
    const s = sine(300, 1.3);
    const d = readSound(writeSound({ rate: 22050, samples: s, source: "boom.mp3" }));
    expect([d.rate, d.frames, d.source]).toEqual([22050, s.length, "boom.mp3"]);
    expect(rms(s, d.samples)).toBeLessThan(0.01);
  });

  it("is about a quarter of 16-bit samples", () => {
    expect(writeSound({ rate: 22050, samples: sine(300, 2) }).length).toBeLessThan(2 * 22050 * 2 / 4 * 1.4);
  });

  it("says what is wrong with a file that is not one", () => {
    const good = writeSound({ rate: 22050, samples: sine(300, 0.5), source: "boom.wav" });
    expect(() => readSound("nope")).toThrow(/one line of JSON/);
    expect(() => readSound(JSON.stringify({ trigscript: "sound", version: 9, data: "" }))).toThrow(/newer TrigScript/);
    expect(() => readSound(JSON.stringify({ ...JSON.parse(good), frames: 22050 * 5 }))).toThrow(/cut short/);
    expect(() => readSound(JSON.stringify({ ...JSON.parse(good), rate: 4000 }))).toThrow(/8 000 to 48 000/);
    expect(describeSound(good)).toBe("A sound, 0.50 seconds at 22,050 Hz, from boom.wav.");
    expect(describeMedia("sfx/boom.sound", good)).toBe(describeSound(good));
  });

  it("is a file of the script, kept in the map", () => {
    expect(isMediaFile("sfx/boom.sound")).toBe(true);
    const files = { "main.ts": "a", "sfx/boom.sound": "b" };
    expect(readFiles(withFiles(new Map(), files))).toEqual(files);
  });
});

describe("a Clip when the script is built", () => {
  const ramp = makeClip(Float32Array.from({ length: 100 }, (_, i) => i / 100), 100);

  it("trims, louder or quieter, fades, reverses, joins and repeats", () => {
    expect([ramp.seconds, ramp.rate]).toEqual([1, 100]);
    expect(ramp.peak).toBeCloseTo(0.99, 5);
    expect(Array.from(clipSamples(ramp.trim(0.5, 0.53)))).toEqual([0.5, 0.51, 0.52].map((v) => Math.fround(v)));
    expect(ramp.gain(2).peak).toBeCloseTo(1.98, 5);
    const faded = clipSamples(ramp.gain(0).gain(1).fade(0.1, 0.1));
    expect([faded[0], faded[99]]).toEqual([0, 0]);
    expect(clipSamples(ramp.reverse())[0]).toBeCloseTo(0.99, 5);
    // A clip of another rate joins at this one's.
    expect(ramp.then(silence(0.5), ramp).seconds).toBeCloseTo(2.5, 2);
    expect(ramp.repeat(3).seconds).toBe(3);
    expect(() => ramp.trim(0.5, 2)).toThrow(/not inside the clip/);
    expect(() => ramp.repeat(0)).toThrow(/1 or more/);
  });

  it("pitches as a sampler does: an octave up is half as long and twice the pitch", () => {
    const a = tone(440, 1);
    const up = a.pitch(12);
    expect(up.seconds).toBeCloseTo(0.5, 3);
    // Zero crossings a second: twice a 440 Hz tone's.
    const crossings = (c: typeof a) => { const s = clipSamples(c); let n = 0; for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 !== s[i] < 0) n++; return n / c.seconds; };
    expect(crossings(up) / crossings(a)).toBeCloseTo(2, 1);
  });

  it("mixes one clip over another, from where it is told", () => {
    const m = ramp.mix(ramp.gain(0.5), 0.5);
    expect(m.seconds).toBe(1.5);
    expect(clipSamples(m)[60]).toBeCloseTo(0.6 + 0.05, 5);
  });

  it("makes tones by hertz or a note's name, noise the same every time, and silence", () => {
    expect(hertz("A4")).toBe(440);
    expect(hertz("A5")).toBe(880);
    expect(hertz("C4")).toBeCloseTo(261.63, 2);
    expect(hertz("C#4")).toBeCloseTo(hertz("Db4"), 9);
    expect(() => hertz("H2")).toThrow(/note's name/);
    expect(tone("A4", 0.5, { volume: 0.25 }).peak).toBeCloseTo(0.25, 2);
    for (const wave of ["square", "triangle", "saw"] as const) expect(tone(220, 0.2, { wave }).peak).toBeCloseTo(0.5, 1);
    expect(Array.from(clipSamples(noise(0.1)))).toEqual(Array.from(clipSamples(noise(0.1))));
    expect(silence(0.2).peak).toBe(0);
    expect(() => tone(440, 0)).toThrow(/more than 0/);
  });

  it("gives the map ADPCM but for a tone it would make harsh, which goes in as 16-bit", () => {
    const format = (c: ReturnType<typeof tone>) => new DataView(clipFile(c).bytes!.buffer).getUint16(20, true);
    expect(format(tone("C5", 0.3))).toBe(0x11);
    expect(format(tone("C5", 0.3, { wave: "square", volume: 0.25 }).fade(0.005, 0.12))).toBe(1);
    expect(adpcmFidelity(clipSamples(tone("C5", 0.3)), 22050)).toBeGreaterThan(30);
    // Noise keeps ADPCM, however far the coding is from it: the error is lost in the noise.
    expect(format(noise(0.2).fade(0, 0.15))).toBe(0x11);
    expect(periodicity(clipSamples(noise(0.2)), 22050)).toBeLessThan(0.3);
    expect(periodicity(clipSamples(tone("C5", 0.2, { wave: "square" })), 22050)).toBeGreaterThan(0.9);
    const pcm = clipFile(tone("C5", 0.3, { wave: "square" })).bytes!;
    expect(pcm.length).toBe(44 + Math.round(0.3 * 22050) * 2);
  });

  it("rounds off a square wave's jumps, so nothing folds back past half the rate", () => {
    // A naive square at 3 kHz and 22 kHz folds its 5th harmonic (15 kHz) down to 7 050 Hz; PolyBLEP leaves little there.
    const s = clipSamples(tone(3000, 0.5, { wave: "square" })), rate = 22050;
    const amp = (hz: number) => { let re = 0, im = 0; for (let i = 0; i < s.length; i++) { re += s[i] * Math.cos((2 * Math.PI * hz * i) / rate); im += s[i] * Math.sin((2 * Math.PI * hz * i) / rate); } return (2 * Math.hypot(re, im)) / s.length; };
    expect(amp(7050) / amp(3000)).toBeLessThan(0.05);
  });

  it("gives the map one WAV a clip, named by what it holds", () => {
    const a = clipFile(tone("A4", 0.2)), b = clipFile(tone("A4", 0.2)), c = clipFile(tone("B4", 0.2));
    expect(a.path).toMatch(/^staredit\\wav\\trigscript-[0-9a-f]{8}\.wav$/);
    expect(a.path).toBe(b.path);
    expect(c.path).not.toBe(a.path);
  });
});

describe("two channels, the limiter and resampling", () => {
  /** A tone's strength at `hz` in samples at `rate`. */
  const amp = (s: Float32Array, hz: number, rate: number) => { let re = 0, im = 0; for (let i = 0; i < s.length; i++) { re += s[i] * Math.cos((2 * Math.PI * hz * i) / rate); im += s[i] * Math.sin((2 * Math.PI * hz * i) / rate); } return (2 * Math.hypot(re, im)) / s.length; };

  it("pans by a balance: the far side down, the middle as it was", () => {
    const a = tone("A4", 0.2, { volume: 0.5 });
    expect(a.channels).toBe(1);
    const left = a.pan(-1), [l, r] = clipChannels(left);
    expect([left.channels, Math.max(...l), Math.max(...r)]).toEqual([2, Math.max(...clipSamples(a)), 0]);
    const [ml, mr] = clipChannels(a.pan(0));
    expect(Array.from(ml)).toEqual(Array.from(mr));
    const [hl, hr] = clipChannels(a.pan(0.5));
    expect(Math.max(...hl) / Math.max(...hr)).toBeCloseTo(0.5, 2);
    expect(() => a.pan(2)).toThrow(/−1 \(left\) to 1/);
    expect(left.mono().channels).toBe(1);
  });

  it("mixes and joins one channel with two as two, the one heard from both sides", () => {
    const mono = tone("A4", 0.2), right = tone("E5", 0.2).pan(1);
    for (const c of [mono.mix(right), mono.then(right), mixdown([{ clip: mono, at: 0 }, { clip: right, at: 0.1 }])]) expect(c.channels).toBe(2);
    const [l] = clipChannels(mono.mix(right));
    expect(Array.from(l)).toEqual(Array.from(clipSamples(mono)));
    // The methods keep both sides.
    expect([right.gain(0.5), right.fade(0.01, 0.01), right.trim(0, 0.1), right.reverse(), right.pitch(3), right.repeat(2), right.envelope([0, 1], [0.2, 0])].map((c) => c.channels)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it("limits a mix under its ceiling, smoothly, and leaves a quiet one alone", () => {
    const loud = mixdown(Array.from({ length: 6 }, (_, k) => ({ clip: tone(220 * (k + 1), 0.5, { volume: 0.4 }), at: k * 0.02 })));
    expect(loud.peak).toBeGreaterThan(1);
    const limited = loud.limit();
    expect(limited.peak).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    expect(limited.seconds).toBe(loud.seconds);
    // No step in the gain: from one sample to the next it changes by little.
    const g = clipSamples(limited).map((x, i) => (Math.abs(clipSamples(loud)[i]) > 0.05 ? x / clipSamples(loud)[i] : NaN)).filter((x) => !Number.isNaN(x));
    let jump = 0;
    for (let i = 1; i < g.length; i++) jump = Math.max(jump, Math.abs(g[i] - g[i - 1]));
    expect(jump).toBeLessThan(0.05);
    const quiet = tone("A4", 0.3, { volume: 0.3 });
    expect(Array.from(clipSamples(quiet.limit()))).toEqual(Array.from(clipSamples(quiet)));
    expect(quiet.normalize().peak).toBeCloseTo(LIMIT_CEILING, 3);
    // Both sides turned down together, so the balance stays.
    const [l, r] = clipChannels(loud.pan(0.5).limit());
    expect(Math.max(...l) / Math.max(...r)).toBeCloseTo(0.5, 1);
  });

  it("pitches up without folding the top back down as other pitches", () => {
    // A 3 kHz sine an octave up, at 22 050: 6 kHz, and the straight-line resampler's images near 16 kHz folded to 5 kHz.
    const up = clipSamples(tone(3000, 0.5).pitch(12)), rate = 22050;
    expect(amp(up, 6000, rate)).toBeGreaterThan(0.45);
    for (const hz of [4000, 5000, 7000, 9000]) expect(amp(up, hz, rate), `${hz}`).toBeLessThan(0.002);
  });

  it("joins clips of another rate at full width: a 44.1 kHz mix keeps a 15 kHz tone", () => {
    const hi = tone(15000, 0.3, { rate: 44100 });
    const mixed = mixdown([{ clip: hi, at: 0 }, { clip: tone("A4", 0.3), at: 0 }], undefined, 44100);
    expect(mixed.rate).toBe(44100);
    expect(amp(clipSamples(mixed), 15000, 44100)).toBeGreaterThan(0.45);
  });
});

describe("what the map gets for a clip", () => {
  const wasm = readFileSync(resolve(import.meta.dirname, "..", "node_modules", "wasm-media-encoders", "wasm", "ogg.wasm"));
  const encoder = vorbisEncoder(wasm);

  it("a long clip as Ogg Vorbis, named by its samples before it is encoded; a short one or wav() as a WAV", () => {
    const long = tone("A4", 2.5), f = clipFile(long);
    expect(f.path).toMatch(/^staredit\\wav\\trigscript-[0-9a-f]{8}\.ogg$/);
    expect(f.bytes).toBeUndefined();
    expect(f.vorbis?.rate).toBe(22050);
    expect(clipFile(tone("A4", 2.5)).path).toBe(f.path);
    expect(clipFile(tone("A4", 2.5, { volume: 0.4 })).path).not.toBe(f.path);
    expect(clipFile(long.wav()).path).toMatch(/\.wav$/);
    expect(clipFile(long.wav().gain(0.5)).path).toMatch(/\.wav$/);
    expect(isBuiltSound(f.path)).toBe(true);
  });

  it("a short clip with two sides as a 16-bit WAV of two channels", () => {
    const f = clipFile(tone("A4", 0.2).pan(-0.5)), v = new DataView(f.bytes!.buffer);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint16(32, true), v.getUint16(34, true)]).toEqual([1, 2, 4, 16]);
    expect(f.bytes!.length).toBe(44 + Math.round(0.2 * 22050) * 4);
  });

  it("encodes Ogg Vorbis the same each time, of the clip's length, a tenth of 16-bit", () => {
    const song = mixdown([{ clip: tone("A4", 3, { rate: 44100 }).pan(-0.3), at: 0 }, { clip: tone("E5", 3, { rate: 44100 }).pan(0.3), at: 0 }]);
    const a = encoder.encode(clipChannels(song), song.rate), b = encoder.encode(clipChannels(song), song.rate);
    expect(String.fromCharCode(...a.slice(0, 4))).toBe("OggS");
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBeLessThan((song.seconds * song.rate * 4) / 10);
    // The last page's granule position: the samples it holds.
    let last = 0;
    for (let i = a.length - 27; i >= 0; i--) if (a[i] === 0x4f && a[i + 1] === 0x67 && a[i + 2] === 0x67 && a[i + 3] === 0x53) { last = i; break; }
    expect(Number(new DataView(a.buffer, a.byteOffset).getBigUint64(last + 6, true))).toBe(Math.round(song.seconds * song.rate));
  });

  it("is encoded by a build, and only named by a check; a trigger's long clip is a WAV", () => {
    const files = { "main.ts": `const long = tone("A4", 3).pan(0.4);
trigger(P1, [always()], [playWav(tone("C5", 3), 0)]);
program(async () => { playWav(long, 0); });
` };
    const built = compileScript(ts, files, defaultScriptNames(), { lib: LIB });
    expect(built.diagnostics).toEqual([]);
    const ogg = built.sounds.find((s) => s.path.endsWith(".ogg"))!, wav = built.sounds.find((s) => s.path.endsWith(".wav"))!;
    // The trigger's: a WAV, ADPCM as a sine allows.
    expect([ogg.vorbis?.channels.length, new DataView(wav.bytes!.buffer).getUint16(20, true)]).toEqual([2, 0x11]);
    const check = compileScript(ts, files, defaultScriptNames(), { lib: LIB });
    finishSounds(check.sounds, null);
    expect(check.sounds.find((s) => s.path === ogg.path)).toEqual({ path: ogg.path });
    // A check's unencoded clip is refused unless the map has it already.
    expect(() => withSounds(new Map(), check.sounds)).toThrow(/was not encoded/);
    expect(withSounds(new Map([[ogg.path, new Uint8Array([1])]]), check.sounds).get(ogg.path)).toEqual(new Uint8Array([1]));
    finishSounds(built.sounds, encoder);
    expect(built.sounds.every((s) => s.bytes && !s.vorbis)).toBe(true);
    expect(String.fromCharCode(...ogg.bytes!.slice(0, 4))).toBe("OggS");
  });
});

describe("a script that plays clips", () => {
  const boom = writeSound({ rate: 22050, samples: sine(110, 0.5), source: "boom.wav" });
  const compile = (main: string) => compileScript(ts, { "main.ts": main, "sfx/boom.sound": boom }, defaultScriptNames(), { lib: LIB });
  const errors = (r: ReturnType<typeof compile>) => r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`);

  it("puts each clip a program plays in the map once, and plays it by that name", () => {
    const r = compile(`import boom from "./sfx/boom.sound";
const beep = tone("A5", 0.1, { wave: "square", volume: 0.3 }).fade(0, 0.05);
const both = boom.gain(0.5).then(silence(0.1), beep);
program(async () => { playWav(boom, 0); await nextFrame(); playWav(both, 0); playWav(beep, 0); playWav(beep, 0); });
`);
    expect(errors(r)).toEqual([]);
    expect(r.sounds).toHaveLength(3);
    const texts = r.strings.map((s) => ("text" in s ? s.text : ""));
    for (const s of r.sounds) expect(texts).toContain(s.path);
  });

  it("is written into the map when applied, and a clip no longer played is taken out", () => {
    const files = { "main.ts": `program(async () => { playWav(tone("A4", 0.1), 0); });\n` };
    const r = compileScript(ts, files, defaultScriptNames(), { lib: LIB });
    const stale = "staredit\\wav\\trigscript-0badf00d.wav", mine = "staredit\\wav\\mine.wav";
    const before = new Map([[stale, new Uint8Array(4)], [mine, new Uint8Array(4)]]);
    let n = 0;
    const plan = buildScript([], before, files, r, () => ++n);
    const names = [...plan.extras.keys()];
    expect(names).toContain(r.sounds[0].path);
    expect(names).toContain(mine);
    expect(names).not.toContain(stale);
  });

  it("keeps an imported sound's own samples when nothing changed it", () => {
    const r = compile(`import boom from "./sfx/boom.sound";\nprogram(async () => { playWav(boom, 0); });\n`);
    const d = readSound(boom), wav = r.sounds[0].bytes!;
    expect(Array.from(wav.slice(60))).toEqual(Array.from(d.adpcm));
  });

  it("says where a build-time mistake is", () => {
    const r = compile(`const beep = tone("Z9", 0.1);\n`);
    expect(errors(r).join("\n")).toMatch(/main\.ts:1: .*note's name/);
  });

  it("is typed: playWav takes a clip, and a clip's methods are checked", () => {
    expect(errors(compile(`import boom from "./sfx/boom.sound";\nboom.pitch("up");\n`)).join("\n")).toMatch(/main\.ts:2: .*string/);
  });
});
