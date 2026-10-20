// ledger: step 5, refused: the action Play WAV
// An instrument from a clip, played at each note's pitch: `music.sampler(clip, root)`.
import { music } from "trigscript/music";
const harp = music.sampler(pluck("C4", 0.5), "C4");
const tune = music.song({ bpm: 120 }, music.track(harp, "C4 E4 G4 C5"));
program(async () => {
  await music.play(tune);
});
