// ledger: step 5, takes
// A location centred on a point of the map, in pixels from values of the program, its size kept:
// `centerLocation(location, x, y)`.
const spot = reserveLocation("ledger: where the point is");
program(() => {
  let x = 64;
  x += 32;
  centerLocation(spot, x, 96);
});
