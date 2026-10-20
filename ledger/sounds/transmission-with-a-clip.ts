// ledger: step 5, takes
// The action Transmission with a clip made when the map is built as its sound.
const chirp = tone([[0, 800], [0.2, 1600]], 0.2, { volume: 0.3 });
program(() => {
  transmission("Incoming.", units.TerranMarine, locations.Anywhere, "add", 0, chirp, 200);
});
