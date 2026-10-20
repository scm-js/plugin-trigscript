// ledger: step 5, refused: a player's supply (provided)
// The supply a player's depots, overlords or pylons provide, of one race: `supply(P1, "provided", races.Zerg)`.
program(() => {
  const n = supply(P1, "provided", races.Zerg);
  print(`${n}`);
});
