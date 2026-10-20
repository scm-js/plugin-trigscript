// ledger: step 5, refused: a read of the game (Bring)
// How many units of a type a player has at a location, read when the line runs: `countUnits(P1, …, location)`.
program(() => {
  const n = countUnits(P1, units.TerranMarine, locations.Anywhere);
  print(`${n}`);
});
