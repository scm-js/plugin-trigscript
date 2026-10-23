// ledger: step 3, takes
// `cover(picture, shapes)`: the brushes that draw a picture, worked out when the map is built; the
// program reads them from an array at a place it works out.
const brushes = cover([".##.", "####", "####"], [["#@#"]]);
const xs = brushes.map((b) => b.x);
program(() => {
  let i = 0;
  let sum = 0;
  while (i < xs.length) {
    sum += xs[i];
    i += 1;
  }
  print(`${sum}`);
});
