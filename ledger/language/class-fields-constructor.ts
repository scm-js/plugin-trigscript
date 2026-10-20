// ledger: step 0, takes
// A class with fields and a constructor: an instance is a record whose fields the constructor sets.
class Wave {
  left = 0;
  constructor(public count: number) {
    this.left = count;
  }
}
program(() => {
  let n = 0;
  while (n < 3) n += 1;
  const w = new Wave(n);
  while (w.left > 0) w.left -= 1;
  print(`${w.count} ${w.left}`);
});
