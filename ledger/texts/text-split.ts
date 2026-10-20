// ledger: step 9, refused: the length of an array that grows
// A text cut at a separator into an array of texts: `"a,b,c".split(",")`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  const parts = (n > 10 ? "1,2,3" : "4,5").split(",");
  print(`${parts.length}`);
});
