// ledger: step 0, takes
// An instance under a second name is the same instance: a change through one is seen through the other.
class Counter {
  n = 0;
}
program(() => {
  const a = new Counter();
  const same = a;
  let k = 0;
  while (k < 4) {
    same.n += k;
    k += 1;
  }
  print(`${a.n}`);
});
