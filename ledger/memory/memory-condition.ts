// ledger: step 6, refused: the condition Deaths
// A cell of the game's memory compared, by its address (EUD): `memory(address, ">=", value)`.
program(() => {
  if (memory(0x58A364, ">=", 1)) print("set");
});
