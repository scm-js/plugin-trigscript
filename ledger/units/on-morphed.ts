// ledger: step 11, refused: an event handled (on.morphed)
// A unit that turns into another type and stays the same unit, with the type it was: `on.morphed((u, was) => …)`.
program(async () => {
  on.morphed((u, was) => {
    if (was == units.ZergLarva) print("hatched");
  });
});
