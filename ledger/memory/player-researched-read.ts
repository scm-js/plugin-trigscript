// ledger: step 6, takes
// Whether a player has a technology, tested in an `if`.
program(() => {
  if (stats(P1).researched[techs.StimPacks]) print("stim ready");
});
