// ledger: step 11, takes
// A class of error with a field of its own, its `name`, and a message made while the game runs, read in the `catch`.
class OutOfGold extends Error {
  need: number;
  constructor(need: number) {
    super(`need ${need} more`);
    this.need = need;
  }
}
program(() => {
  let gold = 0;
  while (gold < 20) gold += 7;
  try {
    if (gold < 50) throw new OutOfGold(50 - gold);
  } catch (e) {
    if (e instanceof OutOfGold) print(`${e.name}: ${e.message} (${e.need})`);
  }
});
