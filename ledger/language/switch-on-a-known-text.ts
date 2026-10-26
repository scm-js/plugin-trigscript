// ledger: step 0, takes
// A `switch` on a text known when the script is built takes its case then: no text is compared in the game.
const MODE: string = "fast";
program(() => {
  let n = 0;
  switch (MODE) {
    case "slow": n = 2; break;
    case "fast": n = 1; break;
    default: n = 9;
  }
  print(`${n}`);
});
