// ledger: step 6, takes
// A technology's research cost and time, and the energy a cast takes, written: `stats(techs.*)`.
program(() => {
  stats(techs.StimPacks).minerals = 50;
  stats(techs.StimPacks).gas = 50;
  stats(techs.StimPacks).time = 40;
  stats(techs.Lockdown).energy = 75;
});
