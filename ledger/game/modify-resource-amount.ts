// ledger: step 5, takes
// The action Modify Unit Resource Amount: what the mineral fields and geysers at a location hold.
program(() => {
  modifyResourceAmount(players.Neutral, 500, "All", locations.Anywhere);
});
