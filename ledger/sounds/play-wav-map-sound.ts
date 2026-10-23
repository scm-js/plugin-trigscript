// ledger: step 5, takes
// The action Play WAV of one of the map's own sounds (the Sound Editor's list) by its name, `sounds.Name`.
// The ledger's map has none, so one of the game's own files, chosen when the map is built.
const own = Object.values(sounds) as Sound[];
program(() => {
  playWav(own.length > 0 ? own[0] : "sound\\glue\\mousedown2.wav", 0);
});
