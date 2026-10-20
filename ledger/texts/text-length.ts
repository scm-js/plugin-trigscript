// ledger: step 8, refused: a text's length
// How many characters a text of the program has: `.length`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(`${(n > 10 ? "Medic" : "Marine").length}`);
});
