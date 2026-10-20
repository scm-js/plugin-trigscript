// ledger: step 0, takes
// Destructuring a record inside a record: `const { at: { x } } = p`.
program(() => {
  let p = { hp: 5, at: { x: 1, y: 2 } };
  p.at.x += 6;
  const { hp, at: { x } } = p;
  print(`${hp} ${x}`);
});
