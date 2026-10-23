// ledger: step 0, takes
// `break` and `continue` inside a `for` loop that stays a loop in the map.
program(() => {
  let end = 0;
  while (end < 15) end += 1;
  let total = 0;
  for (let i = 0; i < end; i++) {
    if (i == 2) continue;
    if (i > 6) break;
    total += i;
  }
  print(`${total}`);
});
