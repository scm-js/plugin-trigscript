// ledger: step 0, takes
// `!!n`: a number as a boolean, true when it is not 0.
program(() => {
  let n = 3;
  let on = false;
  let turns = 0;
  while (turns < 5) {
    on = !!n;
    if (on) n -= 1;
    turns += 1;
  }
  print(`${n}`);
});
