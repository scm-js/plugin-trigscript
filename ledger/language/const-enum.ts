// ledger: step 0, takes
// A `const enum` with values given: each member the number it was given.
const enum Cost {
  Marine = 50,
  Medic = 75,
}
program(() => {
  let ore = 400;
  while (ore >= Cost.Medic) ore -= Cost.Marine;
  print(`${ore}`);
});
