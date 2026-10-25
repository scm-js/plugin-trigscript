// ledger: step 6, takes
// A location's edges where it is now: `bounds(location)`, each of left, top, right, bottom a read of the game's location table.
program(() => {
  const b = bounds(locations.Anywhere);
  print(`${b.right - b.left} by ${b.bottom - b.top}`);
});
