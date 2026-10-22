// ledger: step 9, takes
// Values taken out of an array and others put in their place: `xs.splice(i, 1, v)`.
program(() => {
  const xs = [1, 2, 3, 4];
  let i = 0;
  while (i < 2) i += 1;
  xs.splice(i, 1, 9, 9);
  print(`${xs[2]} ${xs[3]}`);
});
