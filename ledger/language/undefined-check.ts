// ledger: step 0, takes
// A number that may be `undefined`, tested with `!== undefined` before it is used.
program(() => {
  let k = 0;
  let total = 0;
  while (k < 6) {
    let n: number | undefined = undefined;
    if (k > 2) n = k;
    if (n !== undefined) total += n;
    k += 1;
  }
  print(`${total}`);
});
