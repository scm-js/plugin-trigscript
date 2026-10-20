// ledger: step 6, refused: a read of memory.vision.countdown
// The game's vision countdown read: `memory.vision.countdown`.
program(() => {
  const left = memory.vision.countdown;
  print(`${left}`);
});
