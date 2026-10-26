/**
 * Notes imported from a MIDI file: the file read (tempo, time signature, track names, running status, a note struck
 * again, the drums on channel 10), the `.notes` file written and read back, and a script making a song of them with
 * `music.midi` — notes on their steps, held, struck together, overlapping notes in voices of their own, the drums by
 * their General MIDI numbers.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { describeMedia, isMediaFile } from "../compiler/media";
import { readMidi, readNotes, writeNotes } from "../compiler/notes";

/** A MIDI file's bytes: format 1, 480 a beat, its tracks' events given as [delta ticks, ...bytes]. */
function smf(tracks: (readonly number[])[][]): Uint8Array {
  const varint = (v: number) => { const out = [v & 0x7f]; while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80); return out; };
  const chunks = tracks.map((events) => {
    const body = events.flatMap(([delta, ...bytes]) => [...varint(delta), ...bytes]).concat([0, 0xff, 0x2f, 0]);
    return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
  });
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, 0x01, 0xe0, ...chunks.flat()]);
}
const name = (text: string) => [0, 0xff, 0x03, text.length, ...[...text].map((c) => c.charCodeAt(0))];

const FILE = smf([
  // The conductor: 140 beats a minute (428 571 µs a beat), 3/4, and later 120.
  [[0, 0xff, 0x51, 3, 0x06, 0x8a, 0x1b], [0, 0xff, 0x58, 4, 3, 2, 24, 8], [1920, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]],
  // A piano: C4 + E4 a beat (running status for the second), G4 half a beat, then C5 struck again before it ends.
  [name("Piano"), [0, 0xc0, 0], [0, 0x90, 60, 100], [0, 64, 100], [480, 0x80, 60, 0], [0, 64, 0], [0, 0x90, 67, 50], [240, 0x80, 67, 0],
   [0, 0x90, 72, 100], [120, 0x90, 72, 100], [120, 0x80, 72, 0], [0, 0x80, 72, 0], [0, 0x90, 48, 127], [0, 0x90, 55, 100], [960, 0x80, 48, 0], [0, 0x80, 55, 0]],
  // Drums on channel 10: kick and closed hat, hat, snare, a cowbell (56), which a kit has no letter for.
  [name("Beat"), [0, 0x99, 36, 110], [0, 42, 80], [60, 36, 0], [0, 42, 0], [180, 42, 80], [60, 42, 0], [180, 38, 100], [0, 56, 100], [60, 38, 0], [0, 56, 0]],
]);

const LIB = defaultLib();
const compile = (main: string, notes: string) => compileScript(ts, { "main.ts": main, "tune.notes": notes }, defaultScriptNames(), { lib: LIB });
const errors = (r: ReturnType<typeof compile>) => r.diagnostics.map((d) => `${d.file}:${d.line}: ${d.message}`);

describe("a MIDI file, read", () => {
  it("keeps the first tempo, the bar from the time signature, the tracks by name and their notes in beats", () => {
    const d = readMidi(FILE, "tune.mid");
    expect(d.bpm).toBeCloseTo(140, 3);
    expect(d.beats).toBe(3);
    expect(d.tempoChanges).toBe(1);
    expect(d.tracks.map((t) => [t.name, t.channel, t.program])).toEqual([["Piano", 1, 1], ["Beat", 10, 1]]);
    const piano = d.tracks[0].notes.map((n) => [n.at, n.beats, n.pitch, n.velocity]);
    expect(piano).toEqual([[0, 1, 60, 100], [0, 1, 64, 100], [1, 0.5, 67, 50], [1.5, 0.25, 72, 100], [1.75, 0.25, 72, 100], [2, 2, 48, 127], [2, 2, 55, 100]]);
    expect(d.tracks[1].notes.map((n) => n.pitch)).toEqual([36, 42, 42, 38, 56]);
  });

  it("says what is wrong with a file that is not one it reads", () => {
    expect(() => readMidi(new Uint8Array([1, 2, 3]))).toThrow(/not a MIDI file/);
    const two = FILE.slice(); two[9] = 2;
    expect(() => readMidi(two)).toThrow(/format 2/);
    expect(() => readMidi(smf([[[0, 0xff, 0x51, 3, 7, 0xa1, 0x20]]]))).toThrow(/no notes/);
  });

  it("writes a .notes file that reads back the same, and says what it holds", () => {
    const d = readMidi(FILE, "tune.mid");
    const text = writeNotes(d);
    expect(readNotes(text)).toEqual(d);
    expect(isMediaFile("music/tune.notes")).toBe(true);
    expect(describeMedia("tune.notes", text)).toBe("Notes: 2 tracks (Piano, Beat), 12 notes, 140 beats a minute (0:02), the tempo changing 1 time (a song plays at the first), from tune.mid.");
    expect(() => readNotes("{}")).toThrow(/not notes TrigScript imported/);
  });
});

describe("a song of imported notes", () => {
  const text = writeNotes(readMidi(FILE, "tune.mid"));

  it("gives a script the tracks and their notes", () => {
    const r = compile(`import tune from "./tune.notes";
const fail = (what: string) => { throw new Error(what); };
if (tune.tracks.length !== 2 || tune.tracks[1].drums !== true || tune.tracks[0].notes[2].note !== "G4" || tune.beats !== 3) fail(JSON.stringify(tune.tracks[0].notes[2]));`, text);
    expect(errors(r)).toEqual([]);
  });

  it("plays each track it names with an instrument: notes on their steps, held, struck together, overlaps in voices of their own", () => {
    const r = compile(`import { music } from "trigscript/music";
import tune from "./tune.notes";
const fail = (what: string) => { throw new Error(what); };
const keys = music.synth({ release: 0.01 });
const s = music.midi(tune, { Piano: keys });
if (s.barFrames !== 31 || Math.abs(s.bpm - 3 * 60 / (31 * 0.042)) > 1e-9) fail(\`\${s.barFrames} \${s.bpm}\`);
// Steps of 31/12 frames: C4+E4 on 0 for four steps, G4 at 4 for two, C5 at 6 and 7, C3+G3 at 8 for eight.
const at = s.at.map((f) => Math.round(f / s.stepFrames));
if (at.join() !== "0,0,4,6,7,8,8") fail(at.join());
const steps = s.which.map((k) => Math.round(s.clips[k].seconds / 0.042 / s.stepFrames));
if (steps.join() !== "4,4,2,1,1,8,8") fail(steps.join());
const loud = s.which.map((k) => s.clips[k].peak);
if (!(Math.abs(loud[2] / loud[0] - 0.5) < 0.02)) fail(loud.join());`, text);
    expect(errors(r)).toEqual([]);
  });

  it("plays the drums by their General MIDI numbers, each as hard as it was struck, leaving out what the kit has no letter for", () => {
    const r = compile(`import { music } from "trigscript/music";
import tune from "./tune.notes";
const fail = (what: string) => { throw new Error(what); };
const kit = music.kit({ k: tone(60, 0.1), h: noise(0.02), s: noise(0.1) });
const s = music.midi(tune, { 1: music.part(kit, { pan: 0.3 }) }, { steps: 2 });
const at = s.at.map((f) => Math.round(f / s.stepFrames));
if (at.join() !== "0,0,1,2" || s.clips.length !== 3) fail(\`\${at.join()} \${s.clips.length}\`);`, text);
    expect(errors(r)).toEqual([]);
    const bad = compile(`import { music } from "trigscript/music";\nimport tune from "./tune.notes";\nmusic.midi(tune, { Drums: music.drums() });`, text);
    expect(errors(bad).join("\n")).toMatch(/no track "Drums": their tracks are "Piano", "Beat" \(or 0 to 1\)/);
  });
});
