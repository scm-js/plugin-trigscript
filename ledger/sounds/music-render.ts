// ledger: step 5, refused: the action Play WAV
// A song mixed into one clip when the map is built, every note in time: `music.render(song)`.
import { music } from "trigscript/music";
const lead = music.synth({ volume: 0.2, release: 0.05 });
const tune = music.song({ bpm: 120 }, music.track(lead, "C5 E5 G5 ."));
const mixed = music.render(tune, { rate: 22050 });
program(() => {
  playWav(mixed, 0);
});
