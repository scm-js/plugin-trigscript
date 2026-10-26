// ledger: step 0, takes
// Numbers with a fraction added and subtracted: `x += 0.25`, `x - 0.5`.
program(() => {
  let x = 0.5;
  let n = 0;
  while (n < 5) {
    x += 0.25;
    n += 1;
  }
  if (x - 0.5 > 1.2) print("past 1.2");
  else print("not past 1.2");
});
