// ledger: step 0, takes
// A record written with shorthand fields: `{ x, y }` takes each from the variable of that name.
program(() => {
  let x = 0;
  while (x < 3) x += 1;
  const y = x + 1;
  const p = { x, y };
  print(`${p.x} ${p.y}`);
});
