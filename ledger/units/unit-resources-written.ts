// ledger: step 10, takes
// What a mineral field holds, written: `u.resources = 5000`.
program(() => {
  first({ type: units.MineralFieldType1 })!.resources = 5000;
});
