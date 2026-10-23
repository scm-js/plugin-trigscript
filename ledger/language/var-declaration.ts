// ledger: step 0, takes
// A `var` declaration: the same as a `let` in a program.
program(() => {
  var n = 0;
  while (n < 7) n += 2;
  print(`${n}`);
});
