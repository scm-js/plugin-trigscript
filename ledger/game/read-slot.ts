// ledger: step 5, takes
// What holds a player's slot, as one of `slots.*`: `slot(P3) == slots.Computer`.
program(() => {
  if (slot(P3) == slots.Computer) print("a computer");
});
