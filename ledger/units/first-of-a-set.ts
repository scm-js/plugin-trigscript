// ledger: step 10, takes
// `first(unitsAt(…))`: a set of units as a pick's filter; a pick's method and field through `?.`.
program(() => {
  const u = first(unitsAt(locations.Anywhere, { owner: P1, type: units.TerranMarine }));
  let hp = 0;
  hp = u?.hp ?? 0;
  first({ owner: P2 })?.order("move", locations.Anywhere);
  print(`${hp}`);
});
