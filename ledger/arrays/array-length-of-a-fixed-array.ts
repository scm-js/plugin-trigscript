// ledger: step 0, takes
// The length of an array of a fixed length, known when the map is built: `xs.length`.
program(() => {
  const xs = [4, 8, 15, 16];
  xs[0] = 5;
  let i = 0;
  while (i < xs.length) i += 3;
  print(`${i}`);
});
