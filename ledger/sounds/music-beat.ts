// ledger: step 5, takes
// A drum pattern from the steps each drum hits, when the map is built: `music.beat({ k: [0, 4], h: […] }, 8)`.
import { music } from "trigscript/music";
const drums = music.kit({ k: tone([[0, 150], [0.08, 45]], 0.2, { volume: 0.6 }), h: noise(0.03, { volume: 0.2 }) });
const groove = music.song({ bpm: 120 }, music.track(drums, music.beat({ k: [0, 4], h: [0, 2, 4, 6] }, 8)));
program(async () => {
  await music.play(groove);
});
