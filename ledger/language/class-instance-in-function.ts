// ledger: step 1, takes
// An instance handed to a function, which changes it: the same instance, not a copy.
class Counter {
  n = 0;
}
function twice(c: Counter, by: number) {
  c.n += by;
  c.n += by;
}
program(() => {
  const c = new Counter();
  let k = 0;
  while (k < 3) {
    twice(c, k);
    twice(c, 1);
    k += 1;
  }
  print(`${c.n}`);
});
