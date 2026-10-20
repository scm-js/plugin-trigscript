// ledger: step 5, refused: a text shown to other players than the program's owner
// A text shown to another player than the one the program runs as: `print("…", { to: P2 })`.
program(() => {
  print("for P2", { to: P2 });
});
