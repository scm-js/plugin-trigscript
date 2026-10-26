// ledger: step 10, takes
// A loop over a group of types, the game's own: `unitsOf(P1, { type: units.Men })`.
program(() => {
  let n = 0;
  for (const u of unitsOf(P1, { type: units.Men })) n += 1;
  print(`${n}`);
});
