// ledger: step 6, takes
// A unit type's size (small, medium, large), read: what concussive and explosive damage scale by.
program(() => {
  const size = stats(units.TerranMarine).size;
  print(`${size}`);
});
