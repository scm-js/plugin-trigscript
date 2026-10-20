// ledger: step 0, takes
// A value shifted right by a number written in the script, its top bits zero: `a >>> 28` (a number below zero is large).
program(() => {
  let a = 0;
  while (a > -50) a -= 9;
  print(`${a >>> 28}`);
});
