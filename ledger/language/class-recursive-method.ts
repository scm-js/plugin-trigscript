// ledger: step 1, takes
// A method that calls itself.
class M {
  calls = 0;
  fib(n: number): number {
    this.calls++;
    if (n < 2) return n;
    return this.fib(n - 1) + this.fib(n - 2);
  }
}
program(() => {
  const m = new M();
  let n = 0;
  while (n < 7) n += 1;
  print(`${m.fib(n)} ${m.calls}`);
});
