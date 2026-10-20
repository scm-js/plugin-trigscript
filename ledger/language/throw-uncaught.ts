// ledger: step 11, refused: an error thrown or caught (try, throw)
// A `throw` nothing catches: the game says the error, and the program stops there.
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  print("before");
  if (k > 1) throw new RangeError("k is too large");
  print("after");
});
