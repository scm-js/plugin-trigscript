// ledger: step 1, takes
// An arrow written inside a method reads the instance through `this`, and a field read straight off `new`.
class M {
  x = 1;
  f() {
    const g = () => this.x + 1;
    return g() + this.x;
  }
}
class P {
  constructor(public x: number) {}
}
program(() => {
  const m = new M();
  m.x = 5;
  let k = 4;
  print(`${m.f()} ${new P(k).x}`);
});
