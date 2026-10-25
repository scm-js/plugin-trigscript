// ledger: step 6, takes
// A location moved by a write to its edges: `bounds(location).left += 32` and the rest, where it is now.
program(() => {
  const b = bounds(locations.Anywhere);
  b.left += 32;
  b.right += 32;
  b.top = 0;
  b.bottom -= 16;
});
