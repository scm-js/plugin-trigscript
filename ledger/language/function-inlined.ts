// ledger: step 0, takes
// A function called once: its body put where it is called, its parameter the value it was given.
function bonus(n: number) {
  return n + n + 1;
}
program(() => {
  let gold = 0;
  while (gold < 15) gold += 1;
  gold = bonus(gold);
  print(`${gold}`);
});
