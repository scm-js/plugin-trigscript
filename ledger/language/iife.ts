// ledger: step 0, takes
// A function called where it is written, `(() => { … })()`.
program(() => {
  let n = 0;
  while (n < 4) n += 1;
  const doubled = ((x: number) => x + x)(n);
  print(`${doubled}`);
});
