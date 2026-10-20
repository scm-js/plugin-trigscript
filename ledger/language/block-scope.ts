// ledger: step 0, takes
// A variable declared in a block is that block's own, and a name inside may shadow one outside.
program(() => {
  let n = 1;
  let total = 0;
  while (total < 10) {
    let n = 3;
    n += total;
    total += n;
  }
  n += total;
  print(`${n} ${total}`);
});
