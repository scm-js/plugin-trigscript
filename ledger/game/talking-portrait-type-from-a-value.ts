// ledger: step 5, refused: the action Talking Portrait, its fields from values
// The action Talking Portrait, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.TerranMarine;
  let wave = 3;
  if (wave > 2) kind = units.TerranFirebat;
  talkingPortrait(kind, 2000);
});
