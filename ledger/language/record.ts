// ledger: step 0, takes
// A record, `{ x: 1, y: 2 }`: each field a variable of its own, read and written while the game runs.
program(() => {
  let pos = { x: 1, y: 2 };
  while (pos.x < 10) {
    pos.x += 3;
    pos.y += 1;
  }
  print(`${pos.x} ${pos.y}`);
});
