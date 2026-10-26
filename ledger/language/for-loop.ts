// ledger: step 0, takes
// A `for` loop whose end is a value that changes while the game runs, so it stays a loop in the map.
program(() => {
  let end = 0;
  while (end < 5) end += 1;
  let total = 0;
  for (let i = 0; i < end; i++) total += i;
  print(`${total}`);
});
