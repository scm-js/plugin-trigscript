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

  it("plays it again and again beside the program: start(music.loop(song))", () => {
    // (It never compiled: `while (true) await play(s)` showed the loop no wait of its own.)
    const r = compile(`import { music } from "trigscript/music";
const lead = music.synth();
export const song = music.song({ bpm: 120 }, music.track(lead, "C5 . E5 ."));
program(async () => { start(music.loop(song)); });
`);
    expect(errors(r)).toEqual([]);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings });
    sim.run(60);
    const frames = sim.events.filter((e) => e.action.type === ActionType.PlayWav).map((e) => e.frame);
    // Two notes a turn, six frames apart; a turn of the song every twelve frames.
    const start = frames[0];
    expect(frames.slice(0, 6).map((f) => f - start)).toEqual([0, 6, 12, 18, 24, 30]);
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
  it("makes every preset's notes, and the drum kit's eight drums at 44.1 kHz", () => {
    const r = check(
      `const ps = [music.presets.supersaw(), music.presets.pad(), music.presets.bass(), music.presets.acid(), music.presets.lead(), music.presets.chip(), music.presets.keys(), music.presets.bell(), music.presets.pluck()];
const kit = music.drums();`,
      `for (const p of ps) { const n = p.note("A3", 0.3); if (!(n.peak > 0.01 && n.peak < 1)) fail(\`peak \${n.peak}\`); }
for (const k of ["k", "s", "c", "h", "o", "t", "r", "x"]) { const d = kit.hits[k]; if (!d || d.rate !== 44100 || !(d.peak > 0.05)) fail(k); }
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

describe("writing a song", () => {
  it("moves, stretches and repeats a pattern, and writes a kit's bar from the steps each letter plays on", () => {
    const r = check(
      `const t = music.transpose("A4 - C5 . E5@0.5 | kh", 3), bars = music.transpose(["B4 -", "Bb2 ."], -12) as readonly string[];`,
      `if (t !== "C5 - D#5 . G5@0.5 kh") fail(t as string);
if (bars.join(" / ") !== "B3 - / A#1 .") fail(bars.join(" / "));
const s = music.stretch("C4 - . D4", 2);
if (s !== "C4 - - - . . D4 -") fail(s as string);
if (music.repeat("k h", 3) !== "k h k h k h") fail("repeat");
if (music.beat({ k: [0, 2], s: [2] }, 4) !== "k . ks .") fail(music.beat({ k: [0, 2], s: [2] }, 4));`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check("", `music.transpose("B9", 1);`)).join("\n")).toMatch(/C-1 to B9/);
  });

  it("names chords, turns them over, and puts one over another bass", () => {
    const r = check("",
      `const got = [music.chord("Am"), music.chord("E", 3, 1), music.chord("Dm7", 3), music.chord("C/E", 4), music.chord("Bbmaj7", 3), music.chord("F#dim", 4, 2)];
const want = ["A4+C5+E5", "G#3+B3+E4", "D3+F3+A3+C4", "E3+C4+E4+G4", "A#3+D4+F4+A4", "C5+F#5+A5"];
if (got.join() !== want.join()) fail(got.join(" "));`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check("", `music.chord("Hm");`)).join("\n")).toMatch(/A chord is a root and what kind/);
    expect(errors(check("", `music.chord("Am", 4, 3);`)).join("\n")).toMatch(/Am has 3 notes: its inversion is 0 to 2/);
  });

  it("plays a chord's notes by number, round again an octave up, ^ and _ an octave either way", () => {
    const r = check("",
      `const a = music.over("Am", "1 2 3 4 5 . 1_ 3^^ 1+3@0.5 -", 3);
if (a !== "A3 C4 E4 A4 C5 . A2 E6 A3+E4@0.5 -") fail(a);
const p = music.chords("Am E Dm C", "1+2+3", { octave: 3, lead: true });
if (p.join(" / ") !== "A3+C4+E4 / G#3+B3+E4 / A3+D4+F4 / G3+C4+E4") fail(p.join(" / "));
const plain = music.chords("Am E", "1", { octave: 3 });
if (plain.join() !== "A3,E3") fail(plain.join());`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check("", `music.over("Am", "0 1");`)).join("\n")).toMatch(/numbers from 1, the lowest/);
  });

  it("plays a step as loud as its @ says, a kit's letters and a chord's notes alike", () => {
    const r = check(
      `const lead = music.synth({ volume: 0.4 });
const drums = music.kit({ k: tone(60, 0.1) });
const s = music.song({ bpm: 120 }, music.track(lead, "A4 A4@0.5 A4@2"), music.track(drums, "k@0.25 . ."));`,
      `const one = lead.note("A4", 0.6).peak, hit = tone(60, 0.1).peak;
const p = s.clips.map((c) => c.peak).sort((a, b) => a - b), want = [0.25 * hit, 0.5 * one, one, 2 * one].sort((a, b) => a - b);
if (s.clips.length !== 4 || p.some((x, k) => Math.abs(x - want[k]) > 0.002)) fail(\`\${p.join(" ")} / \${want.join(" ")}\`);`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check(`const lead = music.synth();`, `music.song({ bpm: 120 }, music.track(lead, "A4 -@0.5")).at;`)).join("\n")).toMatch(/Step 2: "@" follows a note/);
  });

  it("swings every second step late, and lengthens and shortens the notes to their swung steps", () => {
    const r = check(
      `const hat = music.kit({ h: noise(0.02) }), lead = music.synth({ release: 0.01 });
const s = music.song({ bpm: 120, steps: 2, swing: 1 / 3 }, music.track(hat, "h h h h"), music.track(lead, "A4 B4 . ."));`,
      `if (s.stepFrames !== 6 || s.at.join(" ") !== "0 0 8 8 12 20") fail(\`\${s.stepFrames} \${s.at.join(" ")}\`);
const lengths = s.clips.filter((c) => c.seconds > 0.1).map((c) => Math.round(c.seconds / 0.042));
if (lengths.join() !== "8,4") fail(lengths.join());`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check(`const lead = music.synth();`, `music.song({ bpm: 120, swing: 1 }, music.track(lead, "A4"));`)).join("\n")).toMatch(/swing is 0/);
  });

  it("arranges sections: each fills the parts it names, a pattern again until it is full, the others resting", () => {
    const r = check(
      `const lead = music.synth(), drums = music.kit({ k: tone(60, 0.1), h: noise(0.02) });
const parts = { lead: music.part(lead, { pan: 0.5 }), drums: music.part(drums) };
const a = music.section(1, { lead: "C4 - E4 G4", drums: "k h" }, { name: "a" });
const b = a.with({ lead: null }, { name: "b" });
const s = music.arrange({ bpm: 120, steps: 1 }, parts, a, b, music.section(2, { lead: "A4 . . . . . . ." }));
const same = music.song({ bpm: 120, steps: 1 }, music.track(lead, "C4 - E4 G4 . . . . A4 . . . . . . .", { pan: 0.5 }), music.track(drums, "k h k h k h k h . . . . . . . ."));`,
      `if (s.at.join() !== same.at.join() || s.which.join() !== same.which.join() || s.clips.length !== same.clips.length) fail(\`\${s.at.join()} / \${same.at.join()}\`);
if (s.steps !== 16) fail(String(s.steps));
if (JSON.stringify(s.sections) !== JSON.stringify([{ name: "a", bar: 0, bars: 1, frame: 0 }, { name: "b", bar: 1, bars: 1, frame: 48 }, { name: "", bar: 2, bars: 2, frame: 96 }])) fail(JSON.stringify(s.sections));
if (music.render(s).peak !== music.render(same).peak) fail("render");`,
    );
    expect(errors(r)).toEqual([]);
    const parts = `const parts = { lead: music.part(music.synth()) };`;
    expect(errors(check(parts, `music.arrange({ bpm: 120 }, parts, music.section(1, { leed: "C4" }));`)).join("\n")).toMatch(/names "leed", which is no part of the song: its parts are lead/);
    expect(errors(check(parts, `music.arrange({ bpm: 120 }, parts, music.section(2, { lead: "C4 . ." }, { name: "verse" }));`)).join("\n")).toMatch(/lead in verse: a pattern of 3 steps does not fill 2 bars of 16 steps evenly/);
  });

  it("puts a part through a section's own effects in render only, and plays a section's volume either way", () => {
    const setup = `const lead = music.synth({ volume: 0.4, release: 0.01 });
const parts = { lead: music.part(lead) };
const loud = music.section(1, { lead: "A4 . . ." }), soft = loud.with({}, { volume: { lead: 0.5 } });
const muted = loud.with({}, { fx: { lead: (c, t) => (t.bars === 1 && Math.abs(t.seconds - t.bar) < 1e-9 ? c.gain(0) : c) } });
const v = music.arrange({ bpm: 120, steps: 1 }, parts, loud, soft);
const f = music.arrange({ bpm: 120, steps: 1 }, parts, loud, muted);`;
    const r = check(setup,
      `const p = v.which.map((k) => v.clips[k].peak);
if (Math.abs(p[1] / p[0] - 0.5) > 0.01) fail(p.join(" "));
const one = music.render(f, { limit: false });
if (!(one.trim(0, 0.5).peak > 0.2) || one.trim(2, 2.5).peak !== 0) fail(\`\${one.trim(0, 0.5).peak} \${one.trim(2, 2.5).peak}\`);`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check(setup, `program(async () => { await music.play(f); });`)).join("\n")).toMatch(/effects of its own, which only music.render mixes/);
  });

  it("makes a part pump with the beat, a riser as long as asked, an impact, and a section's length in seconds", () => {
    const r = check(
      `const pad = tone("A3", 2, { volume: 0.5 }).pan(0), pumped = music.pump(0.5, 0.5)(pad);`,
      `const dip = pumped.trim(0.501, 0.52).peak, back = pumped.trim(0.95, 0.99).peak;
if (!(dip < 0.3 && back > 0.45)) fail(\`\${dip} \${back}\`);
if (Math.abs(music.bars(143, 4) - 4 * 40 * 0.042) > 1e-9) fail(String(music.bars(143, 4)));
const r = music.riser(music.bars(143, 2));
if (Math.abs(r.seconds - 3.36) > 0.001 || !(r.trim(3.2, 3.3).peak > 4 * r.trim(0.2, 0.3).peak)) fail(\`\${r.seconds}\`);
if (!(music.impact().peak > 0.3)) fail("impact");`,
    );
    expect(errors(r)).toEqual([]);
  });
});

describe("music that follows the game", () => {
  const SONG = `const lead = music.synth({ volume: 0.5, release: 0.05 }), kit = music.kit({ k: tone(60, 0.1, { volume: 0.9 }), h: noise(0.02, { volume: 0.2 }) });
const parts = { lead: music.part(lead, { reverb: 0.3 }), drums: music.part(kit), pad: music.part(music.synth({ volume: 0.3, release: 0.5 })) };
const a = music.section(1, { lead: "C4 . E4 . G4 . . .", drums: "k h k h", pad: "A3+C4+E4 - - - - - - -" }, { name: "a" });
const b = music.section(2, { lead: "A4 - - - . . . .", drums: "k k h h" }, { name: "b" });
const song = music.arrange({ bpm: 120, steps: 2 }, parts, a, b);
const st = music.stems(song, { layers: { drums: ["drums"], tunes: ["lead", "pad"] }, stingers: { crash: noise(0.5) } });`;

  it("cuts a song into a clip a bar a layer, the same bar one clip, its tail kept, and names what it holds", () => {
    const r = check(SONG,
      `if (st.barFrames !== 48 || st.layers.join() !== "drums,tunes" || st.sections.map((x) => x.name).join() !== "a,b") fail(\`\${st.barFrames} \${st.layers} \${st.sections.map((x) => x.name)}\`);
if (st.pieces.length !== 2 || st.pieces[1].length !== 2 || st.pieces[1][0][0] !== st.pieces[1][1][0]) fail("a bar the same as another is the same clip");
// The tunes' last bar rings out whole; the one before is cut two seconds after the bar (its notes end in it).
const before = st.pieces[1][0][1]!, lastBar = st.pieces[1][1][1]!;
if (!(lastBar.seconds > before.seconds) || Math.abs(before.seconds - (48 * 0.042 + 2)) > 1e-3) fail(\`\${before.seconds} \${lastBar.seconds}\`);
if (st.pieces[0][0][1] === st.pieces[1][0][1]) fail("different bars");
const bar = 48 * 0.042;
if (!(st.pieces[0][0][1]!.seconds > bar)) fail(\`a tail: \${st.pieces[0][0][1]!.seconds}\`);
if (st.section("b") !== 1 || st.layer("tunes") !== 1 || st.stinger("crash") !== 0) fail("by name");
if (st.voices < 2 || st.voices > 6) fail(String(st.voices));`,
    );
    expect(errors(r)).toEqual([]);
    expect(errors(check(SONG, `st.section("c");`)).join("\n")).toMatch(/There is no section "c": there are "a", "b"/);
    expect(errors(check(SONG, `music.stems(song, { layers: { x: ["lede"] } });`)).join("\n")).toMatch(/The layer x names "lede", which is no part of the song: its parts are lead, drums, pad/);
    expect(errors(check(SONG, `music.stems(music.song({ bpm: 120 }, music.track(lead, "C4")), { layers: { x: ["lead"] } });`)).join("\n")).toMatch(/a song made of sections, by music.arrange/);
  });

  it("turns every bar down together, so the song played through stays under its peak", () => {
    const r = check(SONG,
      `const pieces: { clip: Clip; at: number }[] = [];
let g = 0;
for (const sec of st.pieces) for (const row of sec) { for (const c of row) if (c) pieces.push({ clip: c, at: g * 48 * 0.042 }); g++; }
const sum = mixdown(pieces), loud = music.stems(song, { layers: { drums: ["drums"], tunes: ["lead", "pad"] }, peak: 1 });
if (!(sum.peak <= 0.8401 && sum.peak > 0.6)) fail(\`\${sum.peak}\`);
if (Math.abs(st.playthrough.peak - sum.peak) > 1e-6 || Math.abs(st.playthrough.seconds - sum.seconds) > 1e-6) fail(\`playthrough \${st.playthrough.peak} \${sum.peak}\`);
if (!(loud.pieces[0][0][0]!.peak > st.pieces[0][0][0]!.peak)) fail("peak");`,
    );
    expect(errors(r)).toEqual([]);
  });

  it("plays a bar at each bar line as the band says: through the song, to a section, a layer off, a stinger, again and again", () => {
    const r = compile(`import { music, Band } from "trigscript/music";
${SONG}
program(async () => {
  const band = new Band();
  start(music.conduct(st, band));
  await sleep(frames(100));
  band.go(st.section("a"));
  band.mute(st.layer("drums"));
  band.sting(st.stinger("crash"));
  await sleep(frames(100));
  band.loop = true;
  band.unmute(st.layer("drums"));
});
`);
    expect(errors(r)).toEqual([]);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings });
    sim.run(400);
    const paths = r.sounds.map((s) => s.path);
    const played = sim.events.filter((e) => e.action.type === ActionType.PlayWav).map((e) => [e.frame, paths.indexOf((r.strings[e.action.wav - 1] as { text: string }).text)]);
    // Clips: 0 a's drums, 1 a's tunes, 2 b's drums, 3 and 4 b's tunes (its last bar rings out whole), 5 the crash.
    // Bars every 48 frames from frame 1, beats every 12: the crash, asked for on frame 101, on the next beat.
    expect(played).toEqual([[1, 0], [1, 1], [49, 2], [49, 3], [97, 2], [97, 4], [109, 5], [145, 1], [193, 3], [241, 2], [241, 4], [289, 2], [289, 3], [337, 2], [337, 4], [385, 2], [385, 3]]);
    // The bars Ogg Vorbis however short; the crash, half a second, a WAV.
    expect(r.sounds.map((s) => s.path.slice(-3))).toEqual(["ogg", "ogg", "ogg", "ogg", "ogg", "wav"]);
  });
});

describe("music that follows the game, in half bars", () => {
  it("cuts every two beats, so a change waits half a bar", () => {
    const r = compile(`import { music, Band } from "trigscript/music";
const lead = music.synth({ volume: 0.5, release: 0.05 });
const parts = { lead: music.part(lead) };
const song = music.arrange({ bpm: 120, steps: 2 }, parts, music.section(1, { lead: "C4 . D4 . E4 . F4 ." }, { name: "a" }), music.section(1, { lead: "A4 . B4 . C5 . D5 ." }, { name: "b" }));
const st = music.stems(song, { layers: { lead: ["lead"] }, every: 2 });
const fail = (what: string) => { throw new Error(what); };
if (st.every !== 2 || st.waits.join() !== "12,12" || st.pieces[0].length !== 2) fail(\`\${st.every} \${st.waits} \${st.pieces[0].length}\`);
program(async () => {
  const band = new Band();
  band.loop = true;
  start(music.conduct(st, band));
  await sleep(frames(30));
  band.go(st.section("b"));
});
`);
    expect(errors(r)).toEqual([]);
    const sim = new ProgramSimulation(r.ir, { strings: r.strings });
    sim.run(100);
    const paths = r.sounds.map((s) => s.path);
    const played = sim.events.filter((e) => e.action.type === ActionType.PlayWav).map((e) => [e.frame, paths.indexOf((r.strings[e.action.wav - 1] as { text: string }).text)]);
    // a's halves on frames 1 and 25; asked for b on frame 31, it begins on 49 (not 97, a bar later); then b again.
    expect(played).toEqual([[1, 0], [25, 1], [49, 2], [73, 3], [97, 2]]);
    const bad = compile(`import { music } from "trigscript/music";
const song = music.arrange({ bpm: 120, steps: 2 }, { lead: music.part(music.synth()) }, music.section(1, { lead: "C4" }));
music.stems(song, { layers: { lead: ["lead"] }, every: 3 });`);
    expect(errors(bad).join("\n")).toMatch(/every few beats of a bar's 4, a number that divides it — not every 3/);
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
