// ledger: step 0, takes
// A field's initial value worked out from another field: `max = 40; hp = this.max`.
class Marine {
  max = 40;
  hp = this.max;
}
program(() => {
  const m = new Marine();
  while (m.hp > 10) m.hp -= 7;
  print(`${m.hp} ${m.max}`);
});
