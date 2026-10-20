// ledger: step 0, takes
// A location the map does not use, taken when the map is built: `reserveLocation(why)`. Worked out when
// the map is built: the program has its number.
const spot = reserveLocation("ledger: a spot of the library's own");
program(() => {
  let n = spot;
  print(`location ${n}`);
});
