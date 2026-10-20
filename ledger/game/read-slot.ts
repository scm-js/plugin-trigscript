// ledger: step 5, refused: a player's slot
// What holds a player's slot, as one of `slots.*`: `slot(P3) == slots.Computer`.
program(() => {
  if (slot(P3) == slots.Computer) print("a computer");
});
