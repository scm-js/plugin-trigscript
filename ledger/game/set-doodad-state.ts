// ledger: step 5, takes
// The action Set Doodad State: a trap or a door at a location turned on or off.
program(() => {
  setDoodadState(players.Neutral, units.FloorGunTrap, locations.Anywhere, "disable");
});
