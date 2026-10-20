// ledger: step 10, refused: a unit's verb (damage)
// A unit damaged by an amount the program worked out: `u.damage(n)`.
program(() => {
  let n = 3;
  while (n < 20) n += 5;
  first({ owner: P1 })?.damage(n);
});
