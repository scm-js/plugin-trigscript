// ledger: step 0, takes
// A `case` with no `break` goes on into the next one, as JavaScript's does.
program(() => {
  let n = 0;
  let score = 0;
  while (n < 3) {
    switch (n) {
      case 0:
        score += 1;
      case 1:
        score += 10;
        break;
      case 2:
        score += 100;
    }
    n += 1;
  }
  print(`${score}`);
});
