// ledger: step 1, takes
// A function for programs to call, written with `game(…)`: `const award = game((n: number) => …)`.
const award = game((n: number): number => n + 5);
program(() => {
  let k = 1;
  while (k < 4) k += 1;
  print(`${award(k)}`);
});
