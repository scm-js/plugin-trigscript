// ledger: step 0, takes
// `instanceof`, answered when the map is built: the class of each instance is known then.
class Animal {
  constructor(public size: number) {}
}
class Bird extends Animal {
  wings = 2;
}
function describe(a: Animal) {
  if (a instanceof Bird) return a.wings + a.size;
  return a.size;
}
program(() => {
  let k = 0;
  while (k < 4) k += 1;
  print(`${describe(new Animal(k))} ${describe(new Bird(k))}`);
});
