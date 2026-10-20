// ledger: step 0, takes
// Destructuring a record into variables: `const { x, y } = pos`.
program(() => {
  let pos = { x: 1, y: 2 };
  while (pos.x < 5) pos.x += 1;
  const { x, y } = pos;
  print(`${x + y}`);
});
