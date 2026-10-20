// ledger: step 5, takes
// The action Transmission: a text, a sound and a talking portrait, the unit pinged on the minimap.
program(() => {
  transmission("Report in.", units.TerranMarine, locations.Anywhere, "add", 0, "sound\\glue\\mousedown2.wav", 500);
});
