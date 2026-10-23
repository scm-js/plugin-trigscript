// ledger: step 11, takes
// A unit that turns into another type and stays the same unit, with the type it was: `on.morphed((u, was) => …)`.
program(async () => {
  on.morphed((u, was) => {
    if (was == units.ZergLarva) print("hatched");
  });
});
