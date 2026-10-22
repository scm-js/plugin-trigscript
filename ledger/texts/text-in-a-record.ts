// ledger: step 8, takes
// A text that is a field of each row of an array of records, written while the game runs: `heroes[i].name = "…"`.
program(() => {
  const heroes = [
    { name: "Raynor", hp: 5 },
    { name: "Kerrigan", hp: 7 },
  ];
  let i = 0;
  while (i < 1) i += 1;
  heroes[i].name = "Tassadar";
  print(heroes[i].name);
});
