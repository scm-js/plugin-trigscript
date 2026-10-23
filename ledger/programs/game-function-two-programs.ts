// ledger: step 7, takes
// One `game(…)` function called from two programs.
const award = game((n: number): number => n + 5);
program(() => {
  print(`${award(1)}`);
});
program(() => {
  print(`${award(2)}`);
}, { owner: P2 });
