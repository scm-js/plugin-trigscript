// ledger: step 1, takes
// `game(…)`: a function for programs to call, which may be exported from another file; its body follows a program's rules.
const award = game((n: number) => n + n + 5);
program(() => {
  let gold = 0;
  let turns = 0;
  while (turns < 3) {
    gold = award(gold);
    gold = award(turns);
    turns += 1;
  }
  print(`${gold}`);
});
