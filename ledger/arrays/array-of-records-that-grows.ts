// ledger: step 9, refused: an array that grows
// An array of records that grows a record at a time: `enemies.push({ hp, x })`.
program(() => {
  const enemies: { hp: number; x: number }[] = [];
  let x = 0;
  while (x < 10) {
    enemies.push({ hp: 20, x });
    x += 4;
  }
  print(`${enemies.length} ${enemies[1].x}`);
});
