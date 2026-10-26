// ledger: step 5, takes
// A drum kit made from nothing, a letter a drum: `music.drums()`.
import { music } from "trigscript/music";
const kit = music.drums();
const groove = music.song({ bpm: 120 }, music.track(kit, "kh h sh h"));
program(async () => {
  await music.play(groove);
});
