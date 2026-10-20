// ledger: step 10, refused: a unit kept in a variable
// A unit variable given another unit: `u = first(…)`.
program(() => {
  let u = first({ owner: P1 });
  if (!u) u = first({ owner: P2 });
  if (u) u.kill();
});
