// ledger: step 10, takes
// A worker sent to mine a mineral field, as a right-click on it sends one: `scv.gather(field)`.
program(() => {
  const field = first({ type: units.MineralFieldType1 });
  if (field) first({ owner: P1, type: units.TerranSCV })?.gather(field);
});
