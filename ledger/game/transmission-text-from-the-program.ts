// ledger: step 5, takes
// The action Transmission, its text made while the game runs: a number of the program in it.
program(() => {
  let left = 4;
  left -= 1;
  transmission(`${left} bunkers left`, units.TerranMarine, locations.Anywhere, "add", 0, "sound\\glue\\mousedown2.wav", 500);
});
