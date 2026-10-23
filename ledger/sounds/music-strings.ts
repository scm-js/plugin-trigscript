// ledger: step 5, takes
// A plucked-string instrument: `music.strings()`.
import { music } from "trigscript/music";
const guitar = music.strings({ brightness: 0.5, decay: 0.6 });
const tune = music.song({ bpm: 120 }, music.track(guitar, "A3 C4 E4 A4"));
program(async () => {
  await music.play(tune);
});
