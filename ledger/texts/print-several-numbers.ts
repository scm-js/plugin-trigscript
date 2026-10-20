// ledger: step 2, takes
// A text with several numbers of the program in it: `` print(`${a} + ${b} = ${a + b}`) ``.
program(() => {
  let a = 0;
  let b = 100;
  while (a < 12) {
    a += 5;
    b -= 7;
  }
  print(`${a} + ${b} = ${a + b}`);
});
