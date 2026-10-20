// ledger: step 0, takes
// A `protected` field: reached from the class and from classes that extend it.
class Soldier {
  protected hp = 10;
}
class Hero extends Soldier {
  hurt(n: number) {
    this.hp -= n;
    return this.hp;
  }
}
program(() => {
  const h = new Hero();
  let left = 10;
  while (left > 0) left = h.hurt(3);
  print(`${left}`);
});
