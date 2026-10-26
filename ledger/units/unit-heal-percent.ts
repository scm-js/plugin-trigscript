// ledger: step 10, takes
// A unit healed by a share of its type's most: `u.heal({ percent: 25 })`.
program(() => {
  first({ owner: P1 })?.heal({ percent: 25 });
});
