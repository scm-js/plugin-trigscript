// ledger: step 11, takes
// The units that turn into one type: `on.morphed(units.TerranSiegeTankSiegeMode, (u) => …)`.
program(async () => {
  on.morphed(units.TerranSiegeTankSiegeMode, (u) => {
    print("sieged");
  });
});
