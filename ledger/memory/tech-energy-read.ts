// ledger: step 6, takes
// The energy a spell costs, read: `stats(techs.Lockdown).energy`.
program(() => {
  const energy = stats(techs.Lockdown).energy;
  print(`${energy}`);
});
