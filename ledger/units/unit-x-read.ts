// ledger: step 10, takes
// Where a unit is across the map, in pixels: `u.x`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.x}`);
});
