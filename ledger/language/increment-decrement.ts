// ledger: step 0, takes
// `++` and `--` on a variable, before and after.
program(() => {
  let up = 0;
  let down = 10;
  while (up < 5) {
    up++;
    --down;
  }
  print(`${up} ${down}`);
});
