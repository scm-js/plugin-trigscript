// ledger: step 0, takes
// A getter and a setter: `get twice()` read like a field, `set twice(v)` written like one.
class Counter {
  n = 0;
  get twice() {
    return this.n + this.n;
  }
  set twice(v: number) {
    this.n = v >> 1;
  }
}
program(() => {
  const c = new Counter();
  let k = 0;
  while (c.twice < 20) {
    c.n += 3;
    k += 1;
  }
  c.twice = 40;
  print(`${c.n} ${k}`);
});
