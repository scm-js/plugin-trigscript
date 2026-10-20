// ledger: step 8, refused: a text's trim()
// A text without the spaces at its ends: `trim()`, `trimStart()`, `trimEnd()`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print((n > 10 ? "  go  " : " stop ").trim());
  print((n > 10 ? "  go" : " stop").trimStart());
  print((n > 10 ? "go  " : "stop ").trimEnd());
});
