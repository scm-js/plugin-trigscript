// ledger: step 9, refused: an array that grows
// The last value of an array taken off it: `xs.pop()`.
program(() => {
  const xs = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs.push(v);
  const last = xs.pop() ?? 0;
  print(`${last}`);
});
