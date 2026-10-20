// ledger: step 4, refused: a random number
// A random whole number below a bound that changes while the game runs: `random(n)`.
program(() => {
  let n = 1;
  while (n < 10) n += 4;
  const roll = random(n);
  if (roll < 5) print("low");
  else print("high");
});
