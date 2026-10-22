// ledger: step 10, refused: a loop over units
// A number from each unit of a set, in an array: `unitsOf(P1).map((u) => u.hp)`.
program(() => {
  const hps = unitsOf(P1).map((u) => u.hp);
  let total = 0;
  for (const h of hps) total += h;
  print(`${total}`);
});
