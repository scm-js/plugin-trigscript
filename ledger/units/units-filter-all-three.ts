// ledger: step 10, refused: a loop over units
// A loop over a player's units of one type inside a location: `unitsAt(there, { owner: P1, type: units.TerranMarine })`.
const there = reserveLocation("where to count");
program(() => {
  let n = 0;
  for (const u of unitsAt(there, { owner: P1, type: units.TerranMarine })) n += 1;
  print(`${n}`);
});
