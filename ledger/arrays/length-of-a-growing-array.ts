// ledger: step 9, takes
// How many values an array that grows holds: `xs.length`.
program(() => {
  const xs: number[] = [];
  let v = 0;
  while (v < 10) {
    xs.push(v);
    v += 3;
  }
  print(`${xs.length}`);
});
