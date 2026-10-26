// ledger: step 3, takes
// An array of records, each with its fields, read and written at a place that changes while the game runs:
// `waves[i].count`.
program(() => {
  const waves = [
    { count: 5, gold: 10 },
    { count: 8, gold: 15 },
  ];
  let i = 0;
  while (i < 1) i += 1;
  waves[i].count += 2;
  print(`${waves[i].count + waves[i].gold}`);
});
