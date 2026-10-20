// ledger: step 0, takes
// Players compared in a function run when the map is built: `P1`, `P2`, `P9`, `players.P12`, each a slot known then.
function slotOf(p: Player) {
  if (p == P1) return 1;
  if (p == P2) return 2;
  if (p == P9) return 9;
  if (p == players.P12) return 12;
  return 0;
}
program(() => {
  let total = slotOf(P2) + slotOf(P9) + slotOf(P12);
  total += 1;
  print(`${total}`);
});
