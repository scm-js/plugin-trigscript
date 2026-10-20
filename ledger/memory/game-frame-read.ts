// ledger: step 6, refused: a read of memory.game.frame
// Game frames since the game began: `memory.game.frame`.
program(() => {
  const frame = memory.game.frame;
  print(`${frame}`);
});
