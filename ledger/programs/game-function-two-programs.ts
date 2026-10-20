// ledger: step 7, refused: a map of our own has one program; this script has 2
// One `game(…)` function called from two programs.
const award = game((n: number): number => n + 5);
program(() => {
  print(`${award(1)}`);
});
program(() => {
  print(`${award(2)}`);
}, { owner: P2 });
