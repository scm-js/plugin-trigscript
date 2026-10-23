// ledger: step 0, takes
// Several variables declared in one statement: `let a = 1, b = 2;`.
program(() => {
  let a = 1,
    b = 2,
    turns = 0;
  while (turns < 4) {
    a += b;
    turns += 1;
  }
  print(`${a} ${b}`);
});
