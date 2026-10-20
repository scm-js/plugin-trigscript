// ledger: step 4, refused: a random number
// A random whole number from 0 to n − 1, the game's own random numbers: `random(6)`.
program(() => {
  const roll = random(6);
  if (roll < 3) print("low");
  else print("high");
});
