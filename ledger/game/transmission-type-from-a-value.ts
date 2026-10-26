// ledger: step 5, takes
// The action Transmission, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  transmission("Report in.", kind, locations.Anywhere, "add", 0, "sound\\glue\\mousedown2.wav", 500);
});
