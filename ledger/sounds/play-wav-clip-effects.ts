// ledger: step 5, takes
// The action Play WAV of a clip put through effects when the map is built: a filter, an echo, a reverb, a limiter.
const zap = tone("A3", 0.4, { wave: "saw", volume: 0.4 }).filter("lowpass", [[0, 300], [0.4, 3000]]).delay(0.1).reverb({ decay: 0.3 }).limit();
program(() => {
  playWav(zap, 0);
});
