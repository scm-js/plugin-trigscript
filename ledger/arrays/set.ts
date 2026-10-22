// ledger: step 9, takes
// A `Set` of numbers: `add`, `has`, `delete` and `size`.
program(() => {
  const seen = new Set<number>();
  let v = 0;
  while (v < 20) {
    seen.add(v);
    v += 6;
  }
  seen.delete(6);
  if (seen.has(12)) print(`${seen.size}`);
});
