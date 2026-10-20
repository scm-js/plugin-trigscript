// ledger: step 8, takes
// Two texts of many each, chosen while the game runs, in one printed text: `` `${NAMES[i]} and ${NAMES[j]}` ``.
const NAMES = ["Raynor", "Kerrigan", "Tassadar", "Zeratul", "Artanis"];
program(() => {
  let i = 0;
  while (i < 3) i += 1;
  let j = 4 - i;
  print(`${NAMES[i]} and ${NAMES[j]}`);
});
