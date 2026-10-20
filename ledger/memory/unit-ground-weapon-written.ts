// ledger: step 6, takes
// A unit type's ground weapon switched to another of `weapons.*`.
program(() => {
  stats(units.TerranMarine).groundWeapon = weapons.C10CanisterRifle;
});
