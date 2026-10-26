// ledger: step 6, takes
// Whether a player has a technology, given: `stats(P1).researched[techs.Lockdown] = true`.
program(() => {
  stats(P1).researched[techs.Lockdown] = true;
});
