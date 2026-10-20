// ledger: step 5, refused: the action Play WAV
// A pattern moved up or down by semitones when the map is built: `music.transpose(pattern, 12)`.
import { music } from "trigscript/music";
const lead = music.synth({ release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, music.transpose("C4 E4 G4 .", 12)));
program(async () => {
  await music.play(tune);
});
