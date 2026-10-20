// ledger: step 5, refused: the action Play WAV
// A song in sections: parts named once (`music.part`), each section saying what they play
// (`music.section`), put in order by `music.arrange`.
import { music } from "trigscript/music";
const parts = { lead: music.part(music.synth({ release: 0.05 })) };
const verse = music.section(1, { lead: "C5 E5 G5 E5" });
const tune = music.arrange({ bpm: 120, steps: 1 }, parts, verse, verse.with({ lead: "G5 E5 C5 ." }));
program(async () => {
  await music.play(tune);
});
