// ledger: step 5, refused: a text shown to other players than the program's owner
// A text shown to every player: `print(…, { to: AllPlayers })`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(`Wave ${n}`, { to: AllPlayers });
});
