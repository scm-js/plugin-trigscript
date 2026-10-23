// ledger: step 1, takes
// A method that changes its instance, called from more than one place: a function with the instance first.
class Counter {
  n = 0;
  bump(by: number) {
    this.n += by;
  }
}
program(() => {
  const c = new Counter();
  let k = 0;
  while (k < 4) {
    c.bump(k);
    c.bump(1);
    k += 1;
  }
  print(`${c.n}`);
});
