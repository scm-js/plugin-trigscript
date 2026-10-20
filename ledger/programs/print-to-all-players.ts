// ledger: step 5, refused: a text shown to other players than the program's owner
// A text shown to every player: `print("…", { to: AllPlayers })`.
program(() => {
  print("for everyone", { to: AllPlayers });
});
