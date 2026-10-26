// ledger: step 5, takes
// A text shown to another player than the program's owner: `print(…, { to: P2 })`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(`${n} left`, { to: P2 });
});
