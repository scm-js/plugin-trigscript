// ledger: step 6, refused: a read of tech.energy
// The energy a spell costs, read: `stats(techs.Lockdown).energy`.
program(() => {
  const energy = stats(techs.Lockdown).energy;
  print(`${energy}`);
});
