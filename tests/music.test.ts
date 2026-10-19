/**
 * The standard library's "trigscript/music": a song's tables made when the script is built — tempo, holds, chords,
 * a kit's letters, the voice limit — and the program that plays them, each note on its frame in the simulator; a song
 * rendered into one clip; and `if (clip)` decided when the script is built.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript, type CompileResult } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { ProgramSimulation } from "../compiler/simulateIr";
import { ActionType } from "../vendor/triggers";
import { clipSamples, makeClip, mixdown, tone } from "../compiler/sound";

const LIB = defaultLib();
const compile = (main: string): CompileResult => compileScript(ts, { "main.ts": main }, defaultScriptNames(), { lib: LIB });
const errors = (r: CompileResult) => r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`);

/** A script that works a song out and checks it, throwing (a build error) when it is not what is wanted. */
const check = (setup: string, assertion: string) => compile(`import { music } from "trigscript/music";\n${setup}\nconst fail = (what: string) => { throw new Error(what); };\n${assertion}\n`);

describe("a song, when the script is built", () => {
  it("rounds the tempo to whole frames a step and says which it plays at", () => {
    const r = check(
      `const lead = music.synth();\nconst s = music.song({ bpm: 120 }, music.track(lead, "C4 . . ."));`,
      `if (s.stepFrames !== 3 || Math.abs(s.bpm - 119.05) > 0.01 || s.steps !== 4) fail(\`\${s.stepFrames} \${s.bpm} \${s.steps}\`);`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("starts a note on its step, holds it through each -, and rests on .", () => {
    const r = check(
      `const lead = music.synth({ release: 0.01 });\nconst s = music.song({ bpm: 120 }, music.track(lead, "C4 - - . E4 . G4 -"));`,
      `if (s.at.join() !== "0,12,18") fail(s.at.join());\n` +
      `if (s.clips.length !== 3 || Math.abs(s.clips[0].seconds - 9 * 0.042) > 0.001 || Math.abs(s.clips[2].seconds - 6 * 0.042) > 0.001) fail(s.clips.map((c) => c.seconds).join());`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("sounds chords together, and plays a note made twice as one clip", () => {
    const r = check(
      `const lead = music.synth();\nconst s = music.song({ bpm: 120 }, music.track(lead, "C4+E4+G4 . C4+E4+G4 ."));`,
      `if (s.at.join() !== "0,0,0,6,6,6" || s.clips.length !== 3 || s.which.join() !== "0,1,2,0,1,2") fail(\`\${s.at.join()} / \${s.which.join()}\`);`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("plays a kit by its letters, and says when a letter is not in it", () => {
    const ok = check(
      `const drums = music.kit({ k: tone(60, 0.1), h: noise(0.02) });\nconst s = music.song({ bpm: 120 }, music.track(drums, "kh h | k ."));`,
      `if (s.at.join() !== "0,0,3,6" || s.clips.length !== 2) fail(s.at.join());`,
    );
    expect(errors(ok)).toEqual([]);
    const bad = check(`const drums = music.kit({ k: tone(60, 0.1) });\nconst s = music.song({ bpm: 120 }, music.track(drums, "k s"));`, "");
    expect(errors(bad).join("\n")).toMatch(/Step 2: the kit has no "s"/);
  });

  it("refuses to play note by note a song that would sound more than the game's 32 at once, and renders it", () => {
    const chord = Array.from({ length: 33 }, (_, k) => ["C", "D", "E", "F", "G", "A", "B"][k % 7] + (2 + Math.floor(k / 7))).join("+");
    const setup = `const lead = music.synth();\nconst s = music.song({ bpm: 120 }, music.track(lead, "${chord} -"));`;
    expect(errors(check(setup, `if (s.voices !== 33) fail(String(s.voices));\nconst one = music.render(s);`))).toEqual([]);
    const r = check(setup, `program(async () => { await music.play(s); });`);
    expect(errors(r).join("\n")).toMatch(/33 notes would sound at once; the game plays 32/);
  });

  it("says what a word that is no note is", () => {
    const r = check(`const lead = music.synth();\nconst s = music.song({ bpm: 120 }, music.track(lead, "C4 H9"));`, "");
    expect(errors(r).join("\n")).toMatch(/not "H9"/);
  });
});

describe("a song played", () => {
  it("starts each note on its frame, the clip the table says", () => {
    const r = compile(`import { music } from "trigscript/music";
const lead = music.synth();
const drums = music.kit({ k: tone(60, 0.1).fade(0, 0.05), h: noise(0.03, { volume: 0.2 }) });
export const song = music.song({ bpm: 120 }, music.track(lead, "C5 - E5 - G5 - - ."), music.track(drums, "kh h kh h kh h kh h"));
program(async () => { await music.play(song); });
`);
    expect(errors(r)).toEqual([]);
    expect(r.sounds).toHaveLength(5);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings });
    sim.run(80);
    const played = sim.events.filter((e) => e.action.type === ActionType.PlayWav).map((e) => ({ frame: e.frame, path: (r.strings[e.action.wav - 1] as { text: string }).text }));
    const start = played[0].frame;
    // Steps of 3 frames: the lead on steps 0, 2 and 4, the kick on 0, 2, 4, 6, the hat on every step.
    const byFrame = new Map<number, number>();
    for (const p of played) byFrame.set(p.frame - start, (byFrame.get(p.frame - start) ?? 0) + 1);
    expect([...byFrame]).toEqual([[0, 3], [3, 1], [6, 3], [9, 1], [12, 3], [15, 1], [18, 2], [21, 1]]);
    for (const p of played) expect(r.sounds.map((s) => s.path)).toContain(p.path);
  });

  it("renders into one clip, every note at its time", () => {
    const r = check(
      `const lead = music.synth({ volume: 0.3 });\nconst s = music.song({ bpm: 120 }, music.track(lead, "A4 . . . A4 . . ."));\nconst one = music.render(s);`,
      `if (Math.abs(one.seconds - s.seconds) > 0.001 || one.peak < 0.2 || one.peak > 0.35) fail(\`\${one.seconds} \${s.seconds} \${one.peak}\`);`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("renders at 44.1 kHz, its notes made again at that rate, panned tracks on their sides, limited under −1.5 dB", () => {
    const r = check(
      `const lead = music.synth({ wave: "saw", volume: 0.5 });
const pad = music.synth({ wave: "triangle", volume: 0.5 });
const s = music.song({ bpm: 120 }, music.track(lead, "A4 - E5 - A5 - - -", { pan: -0.5 }), music.track(pad, "A3+C4+E4 - - - - - - -", { pan: 0.5, volume: 0.8 }));
const one = music.render(s), raw = music.render(s, { limit: false }), low = music.render(s, { rate: 22050 });`,
      `if (one.rate !== 44100 || one.channels !== 2 || low.rate !== 22050) fail(\`\${one.rate} \${one.channels} \${low.rate}\`);
if (!(raw.peak > 1) || one.peak > 0.8401) fail(\`\${raw.peak} \${one.peak}\`);
if (s.clips.some((c) => c.channels !== 2 || c.rate !== 22050)) fail("the song's own clips: two sides, at 22 050");`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("plays a panned track's notes, each once, with two sides", () => {
    const r = check(
      `const lead = music.synth();
const s = music.song({ bpm: 120 }, music.track(lead, "A4 A4 A4 B4", { pan: 1 }), music.track(lead, "A4 . . .", { volume: 0.5 }));`,
      `if (s.clips.length !== 3 || s.clips.filter((c) => c.channels === 2).length !== 2) fail(\`\${s.clips.length} \${s.clips.map((c) => c.channels)}\`);`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check(`const lead = music.synth();`, `music.track(lead, "A4", { pan: 3 });`)).join("\n")).toMatch(/−1 \(left\) to 1/);
  });
});

describe("instruments, effects and the mix", () => {
  it("makes every preset's notes, and the drum kit's seven drums at 44.1 kHz", () => {
    const r = check(
      `const ps = [music.presets.supersaw(), music.presets.pad(), music.presets.bass(), music.presets.acid(), music.presets.lead(), music.presets.chip(), music.presets.keys(), music.presets.bell(), music.presets.pluck()];
const kit = music.drums();`,
      `for (const p of ps) { const n = p.note("A3", 0.3); if (!(n.peak > 0.01 && n.peak < 1)) fail(\`peak \${n.peak}\`); }
for (const k of ["k", "s", "c", "h", "o", "t", "r"]) { const d = kit.hits[k]; if (!d || d.rate !== 44100 || !(d.peak > 0.05)) fail(k); }
if (music.presets.supersaw().note("A3", 0.3).channels !== 2) fail("the supersaw is wide");
if (music.presets.supersaw({ width: 0 }).note("A3", 0.3).channels !== 1) fail("its options over the preset's");`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("opens a synth's filter with each note: the top of a note brighter at its start than its end", () => {
    const r = check(
      `const s = music.synth({ wave: "saw", volume: 0.5, filter: { cutoff: 300, amount: 4, envelope: { decay: 0.2, sustain: 0 } } });
const n = s.note("A2", 1, 44100);`,
      `const early = n.trim(0.02, 0.07).fade(0.01, 0.01).filter("highpass", 2000).peak, late = n.trim(0.8, 0.85).fade(0.01, 0.01).filter("highpass", 2000).peak;
if (!(early > 4 * late)) fail(\`\${early} \${late}\`);`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("puts a track through its fx and the reverb its send asks for, and the whole through the master", () => {
    const r = check(
      `const lead = music.synth({ volume: 0.3 });
const dry = music.song({ bpm: 120 }, music.track(lead, "A4 . . . . . . ."));
const wet = music.song({ bpm: 120 }, music.track(lead, "A4 . . . . . . .", { reverb: 0.8 }));
const echoed = music.song({ bpm: 120 }, music.track(lead, "A4 . . . . . . .", { fx: (c) => c.delay(0.25, { mix: 1 }) }));`,
      `const a = music.render(dry), b = music.render(wet), c = music.render(echoed), quiet = music.render(dry, { master: (m) => m.gain(0.5) });
if (!(b.seconds > a.seconds + 0.5)) fail(\`reverb tail \${a.seconds} \${b.seconds}\`);
if (!(c.seconds > a.seconds)) fail("echo");
if (Math.abs(quiet.peak - a.peak / 2) > 0.01) fail(\`master \${quiet.peak} \${a.peak}\`);`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("keeps a bar a whole number of frames, a step need not be: sixteenths at 143 beats a minute", () => {
    const r = check(
      `const hat = music.kit({ h: noise(0.02) });
const s = music.song({ bpm: 143, steps: 4 }, music.track(hat, "h h h h h h h h h h h h h h h h"));`,
      `if (s.barFrames !== 40 || s.stepFrames !== 2.5 || Math.abs(s.bpm - 142.86) > 0.01) fail(\`\${s.barFrames} \${s.stepFrames} \${s.bpm}\`);
if (s.at.join(" ") !== "0 3 5 8 10 13 15 18 20 23 25 28 30 33 35 38") fail(s.at.join(" "));`,
    );
    expect(errors(r)).toEqual([]);
  });
});

describe("what the library is made of", () => {
  it("decides if (clip) when the script is built: a rest (null) plays nothing, a clip plays", () => {
    const r = compile(`const NOTES = [tone("A4", 0.1), null, tone("B4", 0.1)];\nprogram(async () => { for (const n of NOTES) { if (n) playWav(n, 0); await nextFrame(); } });\n`);
    expect(errors(r)).toEqual([]);
    expect(r.sounds).toHaveLength(2);
  });

  it("shapes a clip's loudness by an envelope", () => {
    const c = makeClip(new Float32Array(100).fill(1), 100).envelope([0, 0], [0.1, 1], [0.5, 0.5], [1, 0]);
    const s = clipSamples(c);
    expect([s[0], s[5], s[10], s[30], s[50], s[75]].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, 1, 0.75, 0.5, 0.25]);
  });

  it("mixes clips at their times into one", () => {
    const one = makeClip(new Float32Array(10).fill(0.5), 100);
    const m = mixdown([{ clip: one, at: 0 }, { clip: one, at: 0.05 }], 0.3);
    const s = clipSamples(m);
    expect([m.seconds, s[0], s[6], s[12], s[20]]).toEqual([0.3, 0.5, 1, 0.5, 0]);
    expect(() => mixdown([])).toThrow(/one at least/);
    expect(tone(440, 0.1).rate).toBe(22050);
  });
});
