/**
 * Sounds a script imports or makes: the `.sound` format and its IMA ADPCM, what a `Clip` does when the script is built,
 * clips made from nothing, and a script whose program plays clips — each clip a WAV for the map's archive, once.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { adpcmFidelity, adpcmWav, clipFile, periodicity, clipSamples, decodeAdpcm, describeSound, encodeAdpcm, hertz, makeClip, noise, readSound, silence, tone, writeSound } from "../compiler/sound";
import { describeMedia, isMediaFile } from "../compiler/media";
import { buildScript, readFiles, withFiles } from "../script";

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
    const format = (c: ReturnType<typeof tone>) => new DataView(clipFile(c).bytes.buffer).getUint16(20, true);
    expect(format(tone("C5", 0.3))).toBe(0x11);
    expect(format(tone("C5", 0.3, { wave: "square", volume: 0.25 }).fade(0.005, 0.12))).toBe(1);
    expect(adpcmFidelity(clipSamples(tone("C5", 0.3)), 22050)).toBeGreaterThan(30);
    // Noise keeps ADPCM, however far the coding is from it: the error is lost in the noise.
    expect(format(noise(0.2).fade(0, 0.15))).toBe(0x11);
    expect(periodicity(clipSamples(noise(0.2)), 22050)).toBeLessThan(0.3);
    expect(periodicity(clipSamples(tone("C5", 0.2, { wave: "square" })), 22050)).toBeGreaterThan(0.9);
    const pcm = clipFile(tone("C5", 0.3, { wave: "square" })).bytes;
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
    const d = readSound(boom), wav = r.sounds[0].bytes;
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
