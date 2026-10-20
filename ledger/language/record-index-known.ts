// ledger: step 0, takes
// A record's field named by a text known when the map is built: `p["hp"]`.
program(() => {
  let p = { hp: 10, shield: 5 };
  while (p["hp"] > 0) {
    p.hp -= 3;
    p.shield += 1;
  }
  print(`${p["hp"]} ${p["shield"]}`);
});
