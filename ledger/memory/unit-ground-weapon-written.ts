// ledger: step 6, refused: a write of unit.groundWeapon
// A unit type's ground weapon switched to another of `weapons.*`.
program(() => {
  stats(units.TerranMarine).groundWeapon = weapons.C10CanisterRifle;
});
