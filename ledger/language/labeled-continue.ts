// ledger: step 0, takes
// `continue outer` from a loop inside another: the outer loop goes on to its next turn.
program(() => {
  let i = 0;
  let turns = 0;
  outer: while (i < 4) {
    i += 1;
    let j = 0;
    while (j < 4) {
      j += 1;
      if (j > i) continue outer;
      turns += 1;
    }
  }
  print(`${turns}`);
});
