// ledger: step 11, takes
// A class of error of the script's own, `class Late extends Error`, told apart in a `catch` with `instanceof`.
class Late extends Error {}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    if (k > 1) throw new Late("late");
    throw new RangeError("range");
  } catch (e) {
    if (e instanceof Late) print("late");
    else print("other");
  }
});
