// ledger: step 11, refused: an event handled (on.morphed)
// The units that turn into one type: `on.morphed(units.TerranSiegeTankSiegeMode, (u) => …)`.
program(async () => {
  on.morphed(units.TerranSiegeTankSiegeMode, (u) => {
    print("sieged");
  });
});
