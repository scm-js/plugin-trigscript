// ledger: step 6, takes
// A player's colour changed while the game runs, to one of `colors`: `stats(P2).color = colors.teal`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if (n > 10) stats(P2).color = colors.teal;
});
