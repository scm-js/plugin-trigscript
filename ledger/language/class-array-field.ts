// ledger: step 3, takes
// A class with a field that is a fixed-length array of numbers.
class Squad {
  hps = [40, 40, 40];
  hurt(i: number, n: number) {
    this.hps[i] -= n;
  }
}
program(() => {
  const s = new Squad();
  let i = 0;
  while (i < 3) {
    s.hurt(i, i + 5);
    s.hurt(i, 1);
    i += 1;
  }
  print(`${s.hps[0]} ${s.hps[2]}`);
});
