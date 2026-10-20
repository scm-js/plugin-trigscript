// ledger: step 8, takes
// Where a text is found in another, from a place that changes while the game runs, −1 when it is not:
// `"abcabc".indexOf("c", i)`, and `lastIndexOf`.
program(() => {
  let i = 0;
  while (i < 3) i += 2;
  print(`${"abcabc".indexOf("c", i)} ${"abcabc".lastIndexOf("a")}`);
});
