// ledger: step 0, takes
// A class that `extends` another: `super(…)` runs the constructor of what it extends first.
class Animal {
  legs = 4;
  constructor(public size: number) {}
}
class Bird extends Animal {
  constructor(size: number, public wings: number) {
    super(size + size);
    this.legs = 2;
  }
}
program(() => {
  let k = 0;
  while (k < 4) k += 1;
  const b = new Bird(k, 7);
  print(`${b.legs} ${b.size} ${b.wings}`);
});
