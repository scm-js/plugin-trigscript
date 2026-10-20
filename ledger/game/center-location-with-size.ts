// ledger: step 5, refused: a location moved (centerLocation)
// A location centred on a point and given a size, all in pixels: `centerLocation(location, x, y, width, height)`.
const spot = reserveLocation("ledger: where the box is");
program(() => {
  let x = 64;
  x += 32;
  centerLocation(spot, x, 96, 32, 32);
});
