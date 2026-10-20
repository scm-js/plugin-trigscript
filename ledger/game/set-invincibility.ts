// ledger: step 5, takes
// The action Set Invincibility: units at a location cannot be hurt, or can again.
program(() => {
  setInvincibility(P1, units.TerranMarine, locations.Anywhere, "enable");
});
