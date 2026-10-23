// ledger: step 0, takes
// `return` at the top of a program: the program ends there, for good.
program(() => {
  let n = 1;
  print("a");
  if (n > 0) return;
  print("b");
});
