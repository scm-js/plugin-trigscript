// ledger: step 2, takes
// A text with a whole number of the program in it, written out in digits: `` print(`Wave ${wave}`) ``.
program(() => {
  let wave = 0;
  while (wave < 12) wave += 5;
  print(`Wave ${wave} of 20`);
});
