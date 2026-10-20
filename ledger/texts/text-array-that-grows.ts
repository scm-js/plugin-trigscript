// ledger: step 9, refused: the length of an array that grows
// An array of texts that grows: `log.push("wave")`.
program(() => {
  const log: string[] = [];
  let n = 0;
  while (n < 12) {
    log.push("wave");
    n += 5;
  }
  print(`${log.length}`);
});
