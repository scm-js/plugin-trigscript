// ledger: step 0, takes
// `break` leaves the loop it is in.
program(() => {
  let n = 0;
  while (true) {
    n += 3;
    if (n > 10) break;
  }
  print(`${n}`);
});
