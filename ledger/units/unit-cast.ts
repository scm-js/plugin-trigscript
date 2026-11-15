// ledger: step 10, takes
// A spell cast at a unit, as a player's command gives it: `medic.cast(techs.Restoration, marine)`.
program(() => {
  const marine = first({ owner: P1, type: units.TerranMarine });
  if (marine) first({ owner: P1, type: units.TerranMedic })?.cast(techs.Restoration, marine);
});
