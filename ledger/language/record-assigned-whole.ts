// ledger: step 0, takes
// A whole record given a new record: every field set at once.
program(() => {
  let pos = { x: 1, y: 2 };
  let turns = 0;
  while (turns < 3) {
    pos = { x: pos.y, y: pos.x + 1 };
    turns += 1;
  }
  print(`${pos.x} ${pos.y}`);
});
