// ledger: step 8, takes
// A line of JSX with a number of the program in it, put together while the game runs: `<line>Wave {n}</line>`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(<line>Wave {n}</line>);
});
