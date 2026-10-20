// ledger: step 8, refused: a text of the program's
// A list of texts written in the script, looked up at a value that changes while the game runs: `NAMES[i]`.
const NAMES = ["Raynor", "Kerrigan", "Tassadar"];
program(() => {
  let i = 0;
  while (i < 2) i += 1;
  print(NAMES[i]);
});
