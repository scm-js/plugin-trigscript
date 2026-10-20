// ledger: step 4, refused: a quotient by a constant
// A number with a fraction cut to its whole part the JavaScript way: `x | 0`.
program(() => {
  let x = 0.5;
  while (x > -2) x -= 0.75;
  print(`${x | 0}`);
});
