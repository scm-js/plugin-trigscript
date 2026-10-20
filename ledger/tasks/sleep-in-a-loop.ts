// ledger: step 0, takes
// A game loop: a wait of one frame at the end of each turn, `while (…) { …; await sleep(frames(1)); }`.
program(async () => {
  let n = 0;
  while (n < 10) {
    n += 1;
    await sleep(frames(1));
  }
  print(`${n}`);
});
