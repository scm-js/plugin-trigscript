// ledger: step 10, takes
// A unit's hit points taken down by a share of its type's most: `u.damage({ percent: 50 })`.
program(() => {
  first({ owner: P1 })?.damage({ percent: 50 });
});
