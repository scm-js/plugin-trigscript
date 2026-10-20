// ledger: step 5, takes
// The condition Command the Most At as a test in an `if`: the most units of a type at a location.
program(() => {
  if (commandTheMostAt(units.TerranMarine, locations.Anywhere)) print("yes");
});
