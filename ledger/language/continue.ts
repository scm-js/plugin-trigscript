// ledger: step 0, takes
// `continue` goes on to the loop's next turn, skipping the rest of the body.
program(() => {
  let n = 0;
  let counted = 0;
  while (n < 9) {
    n += 1;
    if (n == 3 || n == 6) continue;
    counted += 1;
  }
  print(`${counted}`);
});
