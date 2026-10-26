// ledger: step 0, takes
// A `case` with a block of its own, `case 1: { const x = …; … }`, its variables only its own.
program(() => {
  let n = 0;
  let total = 0;
  while (n < 3) {
    switch (n) {
      case 1: {
        const bonus = n + 10;
        total += bonus;
        break;
      }
      default: {
        const bonus = n + 1;
        total += bonus;
      }
    }
    n += 1;
  }
  print(`${total}`);
});
