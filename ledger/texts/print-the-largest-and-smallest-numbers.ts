// ledger: step 2, takes
// The largest and the smallest numbers a variable holds, printed: 2 147 483 647 and −2 147 483 648.
program(() => {
  let top = 2147483600;
  let bottom = -2147483600;
  while (top < 2147483647) {
    top += 47;
    bottom -= 48;
  }
  print(`${top} ${bottom}`);
});
