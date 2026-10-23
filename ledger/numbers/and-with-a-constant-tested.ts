// ledger: step 0, takes
// Whether a bit of a value is set, in an `if`: `if ((a & 4) !== 0)`.
program(() => {
  let a = 0;
  while (a < 50) a += 9;
  if ((a & 4) !== 0) print("set");
  else print("clear");
});
