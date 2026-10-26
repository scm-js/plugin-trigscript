// ledger: step 3, takes
// An array turned round in place: `xs.reverse()`.
program(() => {
  const xs = [5, 2, 8, 1];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  xs.reverse();
  print(`${xs[0]} ${xs[3]}`);
});
