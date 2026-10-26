// ledger: step 5, takes
// The action Play WAV of two beeps a gap apart, the gap made by `silence()` when the map is built.
const beep = tone("C5", 0.08, { volume: 0.3 });
const twice = beep.then(silence(0.1), beep);
program(() => {
  playWav(twice, 0);
});
