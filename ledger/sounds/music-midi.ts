// ledger: step 5, takes
// A song of notes (as a MIDI file imports them), each track played by an instrument: `music.midi(notes, { Piano: keys })`.
import { music } from "trigscript/music";
const notes: Notes = {
  bpm: 120, beats: 4, tempoChanges: 0,
  tracks: [{ name: "Piano", channel: 1, program: 1, drums: false, notes: [{ at: 0, beats: 1, pitch: 60, note: "C4", velocity: 100 }, { at: 1, beats: 1, pitch: 64, note: "E4", velocity: 100 }] }],
};
const tune = music.midi(notes, { Piano: music.synth({ release: 0.05 }) });
program(async () => {
  await music.play(tune);
});
