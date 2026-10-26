// ledger: step 0, takes
// A text shown to the player the program runs as, named so: `print("…", { to: CurrentPlayer })`.
program(() => {
  print("for me", { to: CurrentPlayer });
}, { owner: P2 });
