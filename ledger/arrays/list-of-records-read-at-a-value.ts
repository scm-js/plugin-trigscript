// ledger: step 3, takes
// A list of records written in the script, looked up at a value that changes while the game runs: `WAVES[i].count`.
const WAVES = [
  { count: 5, gold: 10 },
  { count: 8, gold: 15 },
  { count: 13, gold: 25 },
];
program(() => {
  let i = 0;
  while (i < 2) i += 1;
  print(`${WAVES[i].count + WAVES[i].gold}`);
});
