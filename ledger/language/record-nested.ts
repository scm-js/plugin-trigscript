// ledger: step 0, takes
// A record that holds another record: `p.at.x`.
program(() => {
  let p = { hp: 10, at: { x: 0, y: 0 } };
  while (p.hp > 0) {
    p.at.x += 2;
    p.hp -= 3;
  }
  print(`${p.at.x} ${p.hp}`);
});
