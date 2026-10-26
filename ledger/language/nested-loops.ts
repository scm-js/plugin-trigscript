// ledger: step 0, takes
// A loop inside another, both running while the game runs.
program(() => {
  let i = 0;
  let total = 0;
  while (i < 4) {
    let j = 0;
    while (j < i) {
      total += 1;
      j += 1;
    }
    i += 1;
  }
  print(`${total}`);
});
