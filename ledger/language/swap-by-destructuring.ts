// ledger: step 0, takes
// Two variables swapped with a destructuring assignment: `[a, b] = [b, a]`.
program(() => {
  let a = 1;
  let b = 7;
  let turns = 0;
  while (turns < 3) {
    [a, b] = [b, a];
    a += 1;
    turns += 1;
  }
  print(`${a} ${b}`);
});
