// ledger: step 0, takes
// A text shown to the program's own player, named: `print("…", { to: P2 })` in a program that runs as P2.
program(() => {
  print("for me", { to: P2 });
}, { owner: P2 });
