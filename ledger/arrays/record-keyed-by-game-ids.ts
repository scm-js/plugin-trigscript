// ledger: step 3, takes
// A record keyed by an id of the game, a cell for every id, read and written at a key that changes while the game
// runs: `const score: Record<Player, number> = { [P1]: 0 }`, then `score[p] += 7`.
program(() => {
  const score: Record<Player, number> = { [P1]: 0 };
  let p: Player = P1;
  let n = 0;
  while (n < 3) {
    score[p] += 7;
    p = P2;
    n += 1;
  }
  print(`${score[P1]} ${score[p]}`);
});
