// ledger: step 5, refused: the action Set Invincibility
// The action Set Invincibility: units at a location cannot be hurt, or can again.
program(() => {
  setInvincibility(P1, units.TerranMarine, locations.Anywhere, "enable");
});
