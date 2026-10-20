// ledger: step 0, takes
// `yield*` of another generator inside a generator; `break` leaves both.
function* pair(n: number) {
  yield n;
  yield n + 1;
}
function* all(n: number) {
  yield* pair(n);
  yield* pair(n + 10);
}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  let total = 0;
  for (const x of all(k)) {
    if (x > 12) break;
    total += x;
  }
  print(`${total}`);
});
