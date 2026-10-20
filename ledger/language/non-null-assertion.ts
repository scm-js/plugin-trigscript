// ledger: step 0, takes
// The non-null assertion `x!`: it changes nothing in the map.
program(() => {
  let boss: { hp: number } | null = { hp: 10 };
  let hits = 0;
  while (boss!.hp > 0) {
    boss!.hp -= 3;
    hits += 1;
  }
  print(`${hits}`);
});
