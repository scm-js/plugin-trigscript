// ledger: step 6, refused: a write of unit.permanentCloak
// The rest of a unit type's flags: cloak, burrow, regeneration, invincible, hero, mechanical, robotic.
program(() => {
  stats(units.TerranMarine).permanentCloak = true;
  stats(units.TerranMarine).cloakable = true;
  stats(units.TerranMarine).burrowable = true;
  stats(units.TerranMarine).regenerates = true;
  stats(units.TerranMarine).invincible = false;
  stats(units.TerranMarine).hero = true;
  stats(units.TerranMarine).mechanical = true;
  stats(units.TerranMarine).robotic = false;
});
