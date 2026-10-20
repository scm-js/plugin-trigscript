// ledger: step 11, refused: a map of our own has one program; this script has 2
// A listener at the top of a script, beside a program: a program of its own that listens from the start of the game.
on.created((u) => {
  u.energy = 50;
});
program(() => {
  print("started");
});
