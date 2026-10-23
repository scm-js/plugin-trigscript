// ledger: step 0, takes
// `shared()` in a program for one player, where there is only one copy to share: `let total = shared(0)`.
program(() => {
  let total = shared(0);
  while (total < 5) total += 2;
  print(`${total}`);
});
