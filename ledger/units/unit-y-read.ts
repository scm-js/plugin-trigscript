// ledger: step 10, takes
// Where a unit is down the map, in pixels: `u.y`, here straight off a pick (`first(…)`).
program(() => {
  print(`${first({ owner: P1 })!.y}`);
});
