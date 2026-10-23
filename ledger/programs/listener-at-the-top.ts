// ledger: step 11, takes
// A listener at the top of a script, beside a program: a program of its own that listens from the start of the game.
on.created((u) => {
  u.energy = 50;
});
program(() => {
  print("started");
});
