// ledger: step 0, takes
// `"field" in record` worked out when the map is built.
const BOSS: { hp: number } | { hp: number; shield: number } = { hp: 100, shield: 50 };
program(() => {
  let total = 0;
  if ("shield" in BOSS) total += BOSS.shield;
  total += BOSS.hp;
  total -= 1;
  print(`${total}`);
});
