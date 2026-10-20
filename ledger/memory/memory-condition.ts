// ledger: step 5, takes
// A cell of the game's memory compared, by its address (EUD): `memory(address, ">=", value)`.
program(() => {
  if (memory(0x58A364, ">=", 1)) print("set");
});
