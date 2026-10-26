// ledger: step 6, takes
// Music that follows the game: a song cut into bars and layers (`music.stems`), played by
// `music.conduct(stems, band)` as a `Band` says: which section, which layers, a stinger on the next beat.
import { music, Band } from "trigscript/music";
const parts = { lead: music.part(music.synth({ release: 0.05 })) };
const verse = music.section(1, { lead: "C5 E5 G5 E5" }, { name: "verse" });
const tune = music.arrange({ bpm: 120, steps: 1 }, parts, verse);
const cut = music.stems(tune, { layers: { lead: ["lead"] }, rate: 22050, tail: 0.2 });
program(async () => {
  const band = new Band();
  band.go(cut.section("verse"));
  await music.conduct(cut, band);
});
