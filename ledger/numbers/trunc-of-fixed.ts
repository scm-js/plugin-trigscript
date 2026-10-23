// ledger: step 4, takes
// A number with a fraction cut to its whole part, towards zero: `Math.trunc(x)` (−2.5 is −2).
program(() => {
  let x = 0.5;
  while (x > -2) x -= 0.75;
  print(`${Math.trunc(x)}`);
});
