// ledger: step 5, takes
// The condition Command the Least At as a test in an `if`: the fewest units of a type at a location.
program(() => {
  if (commandTheLeastAt(units.TerranMarine, locations.Anywhere)) print("yes");
});
