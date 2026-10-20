// ledger: step 0, takes
// A method overridden in a class that extends another, `super.speak()` reaching the one it overrides.
class Animal {
  constructor(public size: number) {}
  speak() {
    return this.size + 1;
  }
}
class Bird extends Animal {
  speak() {
    return super.speak() + 100;
  }
}
program(() => {
  let k = 0;
  while (k < 4) k += 1;
  const a = new Animal(k);
  const b = new Bird(k);
  print(`${a.speak()} ${b.speak()}`);
});
