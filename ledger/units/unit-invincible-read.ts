// ledger: step 10, takes
// Whether a unit cannot be hurt, read: `u.invincible`, here straight off a pick (`first(…)`).
program(() => {
  if (first({ owner: P1 })?.invincible) print("invincible");
});
