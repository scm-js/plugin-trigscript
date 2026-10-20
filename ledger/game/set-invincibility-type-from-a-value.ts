// ledger: step 5, takes
// The action Set Invincibility, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  setInvincibility(P1, kind, locations.Anywhere, "enable");
});
