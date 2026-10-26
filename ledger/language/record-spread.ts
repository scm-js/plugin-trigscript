// ledger: step 0, takes
// A record made from another with `...`, one field changed: `{ ...pos, x: 9 }`.
program(() => {
  let pos = { x: 1, y: 2 };
  while (pos.y < 5) pos.y += 1;
  let moved = { ...pos, x: 9 };
  moved.x += pos.x;
  print(`${moved.x} ${moved.y}`);
});
