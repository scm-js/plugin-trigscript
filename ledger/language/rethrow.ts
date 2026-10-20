// ledger: step 11, refused: an error thrown or caught (try, throw)
// An error caught and thrown again, `catch (e) { …; throw e; }`, to a `try` further out.
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    try {
      if (k > 1) throw new Error("inner");
    } catch (e) {
      print("seen inside");
      throw e;
    }
  } catch {
    print("caught outside");
  }
});
