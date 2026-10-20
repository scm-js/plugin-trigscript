// ledger: step 7, refused: a map of our own has no per-player program yet
// A number every player of a program for several players shares, one cell for them all: `let total = shared(0)`.
program(() => {
  let total = shared(0);
  total += 1;
  print(`${total}`);
}, { owner: AllPlayers });
