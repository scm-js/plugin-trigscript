// ledger: step 0, takes
// Destructuring one field and the rest into another record: `const { x, ...others } = p`.
program(() => {
  let p = { x: 1, y: 2, z: 3 };
  while (p.z < 7) p.z += 1;
  const { x, ...others } = p;
  print(`${x} ${others.z}`);
});
