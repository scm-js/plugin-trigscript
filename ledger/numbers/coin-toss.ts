// ledger: step 4, refused: a random boolean
// A coin toss, true or false alike: `random()`.
program(() => {
  if (random()) print("heads");
  else print("tails");
});
