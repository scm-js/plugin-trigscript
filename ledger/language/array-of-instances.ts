// ledger: step 3, takes
// A fixed-length array of instances of a class, a row picked by an index that changes while the game runs.
class Wave {
  constructor(public left: number) {}
  spawn() {
    if (this.left > 0) this.left -= 1;
  }
}
program(() => {
  const waves = [new Wave(2), new Wave(5)];
  let i = 0;
  let which = 0;
  while (i < 4) {
    waves[which].spawn();
    which = 1 - which;
    i += 1;
  }
  print(`${waves[0].left} ${waves[1].left}`);
});
