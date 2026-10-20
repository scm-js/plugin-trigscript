// ledger: step 9, refused: an array that grows
// The first value of an array taken off its front: `xs.shift()`.
program(() => {
  const xs = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs[0] = v;
  const first = xs.shift() ?? 0;
  print(`${first} ${xs[0]}`);
});
