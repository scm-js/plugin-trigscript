// ledger: step 0, takes
// A class that `implements` an interface: the interface is a type only, gone in the map.
interface Scored {
  score(): number;
}
class Kill implements Scored {
  constructor(public worth: number) {}
  score() {
    return this.worth + 1;
  }
}
program(() => {
  let k = 0;
  while (k < 5) k += 1;
  const s: Scored = new Kill(k);
  print(`${s.score()}`);
});
