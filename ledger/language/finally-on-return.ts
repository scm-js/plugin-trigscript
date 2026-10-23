// ledger: step 11, takes
// `finally` in a function: it runs on a `return` out of the `try`, and on an error's way out to the caller's `catch`.
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  let cleaned = 0;
  function guarded(n: number): number {
    try {
      if (n > 2) throw new Error("too big");
      return n * 2;
    } finally {
      cleaned += 1;
    }
  }
  let total = guarded(k - 1);
  try {
    total += guarded(k + 5);
  } catch {
    total += 100;
  }
  print(`${total} ${cleaned}`);
});
