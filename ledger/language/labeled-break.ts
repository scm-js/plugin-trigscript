// ledger: step 0, takes
// A label on a loop, and `break outer` from a loop inside it: both loops are left.
program(() => {
  let i = 0;
  let turns = 0;
  outer: while (i < 5) {
    let j = 0;
    while (j < 5) {
      if (i + j > 4) break outer;
      turns += 1;
      j += 1;
    }
    i += 1;
  }
  print(`${turns}`);
});
