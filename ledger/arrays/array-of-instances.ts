// ledger: step 3, takes
// An array of instances of a class of the script, a method called on one: `towers[i].upgrade()`.
class Tower {
  level = 1;
  upgrade() {
    this.level += 1;
  }
}
program(() => {
  const towers = [new Tower(), new Tower()];
  let i = 0;
  while (i < 1) i += 1;
  towers[i].upgrade();
  print(`${towers[0].level} ${towers[1].level}`);
});
