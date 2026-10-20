// ledger: step 5, refused: the action Set Deaths
// The action Set Deaths, all its fields known when the map is built: the counter a map keeps in the death table.
program(() => {
  setDeaths(P1, units.TerranMarine, "add", 1);
});
