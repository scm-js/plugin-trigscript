// ledger: step 10, refused: a unit's x
// Where a unit is across the map, in pixels: `u.x`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.x}`);
});
