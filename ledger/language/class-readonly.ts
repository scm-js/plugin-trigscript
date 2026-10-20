// ledger: step 0, takes
// A `readonly` field: set once by the constructor, read after.
class Price {
  readonly cost: number;
  constructor(cost: number) {
    this.cost = cost;
  }
}
program(() => {
  let n = 0;
  while (n < 50) n += 1;
  const p = new Price(n);
  let ore = 400;
  while (ore >= p.cost) ore -= p.cost;
  print(`${ore}`);
});
