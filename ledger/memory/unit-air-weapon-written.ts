// ledger: step 6, refused: a write of unit.airWeapon
// A unit type's air weapon: `weapons.None` for none.
program(() => {
  stats(units.TerranMarine).airWeapon = weapons.None;
});
