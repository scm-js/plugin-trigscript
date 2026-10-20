// ledger: step 8, refused: a text kept in a variable
// A number of the program made a text: `String(n)` and `n.toString()`, kept as a text.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  const a = String(n);
  const b = n.toString();
  print(a);
  print(b);
});
