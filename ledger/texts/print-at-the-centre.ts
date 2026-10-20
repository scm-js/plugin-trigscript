// ledger: step 5, refused: a text at the centre of the screen
// A text shown in the middle of the screen, where the game's own messages appear: `print(…, { position: "center" })`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(`Wave ${n}`, { position: "center" });
});
