// ledger: step 9, takes
// A value put at the front of an array: `xs.unshift(v)`.
program(() => {
  const xs = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs.unshift(v);
  print(`${xs[0]} ${xs[1]}`);
});
