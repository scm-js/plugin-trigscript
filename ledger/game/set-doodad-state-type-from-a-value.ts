// ledger: step 5, refused: the action Set Doodad State, its fields from values
// The action Set Doodad State, the unit type from a value of the program.
program(() => {
  let kind: UnitType = units.FloorGunTrap;
  let wave = 3;
  if (wave > 2) kind = units.LeftWallMissileTrap;
  setDoodadState(players.Neutral, kind, locations.Anywhere, "disable");
});
