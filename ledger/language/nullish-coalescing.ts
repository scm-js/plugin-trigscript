// ledger: step 0, takes
// `??` on a number that may be `undefined`: the other side when it is.
program(() => {
  let k = 0;
  let total = 0;
  while (k < 6) {
    let n: number | undefined = undefined;
    if (k > 2) n = k;
    total += n ?? 10;
    k += 1;
  }
  print(`${total}`);
});
