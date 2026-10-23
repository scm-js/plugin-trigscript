// ledger: step 6, takes
// memory() and setMemory() of the deaths table's dwords 12 to 26, which the game would read as player groups: named as the deaths of player e mod 12 of unit e div 12.
program(() => {
  setMemory(0x58a364 + 4 * 13, "set", 7);
  if (memory(0x58a364 + 4 * 13, ">=", 7)) print("the cell");
});
