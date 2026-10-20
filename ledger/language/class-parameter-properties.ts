// ledger: step 0, takes
// Fields declared in the constructor's parameters: `constructor(public x: number, private y: number, readonly z = 9)`.
class P {
  constructor(public x: number, private y: number, readonly z = 9) {}
  sum() {
    return this.x + this.y + this.z;
  }
}
program(() => {
  let k = 0;
  while (k < 3) k += 1;
  const p = new P(1, k);
  while (p.x < 11) p.x += 1;
  print(`${p.sum()}`);
});
