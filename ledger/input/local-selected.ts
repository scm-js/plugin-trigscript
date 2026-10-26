// ledger: step 12, takes
// Whether this computer has a unit selected: `local.selected`, shown but not acted on.
program(() => {
  if (local.selected) print("selected");
  else print("none");
});
