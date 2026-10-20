// ledger: step 4, takes
// A number with a fraction in a printed text, as a decimal of up to four places: `` print(`${x}`) `` of 2.75.
program(() => {
  let x = 0.5;
  while (x < 2.5) x += 0.75;
  print(`${x}`);
});
