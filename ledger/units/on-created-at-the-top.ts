// ledger: step 11, takes
// A listener written at the top of a script, not in a program: it listens from the start of the game.
on.created(units.ZergZergling, (u) => {
  u.energy = 50;
});
