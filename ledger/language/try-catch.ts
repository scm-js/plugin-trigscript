// ledger: step 11, takes
// `try { … } catch { … }`: an error thrown inside the `try` goes to its `catch`.
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    if (k > 1) throw new Error("too many");
    print("fine");
  } catch {
    print("caught");
  }
});
