// ledger: step 9, refused: a variable a closure keeps
// A closure made at each turn of a loop over that turn's `const`, as JavaScript has it.
program(() => {
  let total = 0;
  let f: () => number = () => 0;
  let n = 0;
  while (n < 5) {
    const k = n;
    f = () => k + k;
    total += f();
    n += 1;
  }
  print(`${total}`);
});
