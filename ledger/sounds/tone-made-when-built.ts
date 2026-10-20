// ledger: step 0, takes
// `tone()` makes a clip when the map is built: its length and loudness are numbers the program has as
// constants. Nothing of it is played.
const beep = tone("A4", 0.25, { volume: 0.5 });
program(() => {
  let ms = Math.round(beep.seconds * 1000);
  print(`${ms} ms`);
});
