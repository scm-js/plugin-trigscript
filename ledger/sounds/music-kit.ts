// ledger: step 5, refused: the action Play WAV
// A drum kit of the script's own clips, a letter each: `music.kit({ k: kick, h: hat })`.
import { music } from "trigscript/music";
const drums = music.kit({ k: tone([[0, 150], [0.08, 45]], 0.2, { volume: 0.6 }), h: noise(0.03, { volume: 0.2 }) });
const groove = music.song({ bpm: 120 }, music.track(drums, "kh h kh h"));
program(async () => {
  await music.play(groove);
});
