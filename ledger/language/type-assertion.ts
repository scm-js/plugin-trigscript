// ledger: step 0, takes
// A type assertion, `value as number`: it changes nothing in the map.
program(() => {
  let n = 4 as number;
  let total = 0;
  while (total < 20) total += n;
  print(`${total}`);
});
