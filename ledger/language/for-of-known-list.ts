// ledger: step 0, takes
// `for (const x of [3, 5, 8])`: a loop over a list known when the map is built, written out once an item.
program(() => {
  let total = 0;
  for (const cost of [3, 5, 8]) {
    total += cost;
    sleep(frames(1));
  }
  print(`${total}`);
});
