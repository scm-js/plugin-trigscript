// ledger: step 9, takes
// A `Map` keyed by any number, below zero and large too: `scores.set(key, v)`, `scores.get(key) ?? 0`.
program(() => {
  const scores = new Map<number, number>();
  let key = 1000;
  while (key < 100000) {
    scores.set(key, key / 1000);
    key *= 7;
  }
  print(`${scores.get(7000) ?? 0} ${scores.size}`);
});
