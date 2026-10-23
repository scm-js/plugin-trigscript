// ledger: step 0, takes
// Destructuring that renames a field and gives one that is missing a default: `const { x: left, z = 5 } = …`.
program(() => {
  let pos: { x: number; z?: number } = { x: 1 };
  while (pos.x < 3) pos.x += 1;
  const { x: left, z = 5 } = pos;
  print(`${left} ${z}`);
});
