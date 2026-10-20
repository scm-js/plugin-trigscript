// ledger: step 0, takes
// A print to `CurrentPlayer`, the player the program runs as.
program(() => {
  let n = 0;
  while (n < 3) n += 1;
  print(`${n}`, { to: CurrentPlayer });
});
