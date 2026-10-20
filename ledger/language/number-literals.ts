// ledger: step 0, takes
// Numbers written in hexadecimal, binary and with separators: `0x10`, `0b101`, `1_000`.
program(() => {
  let n = 0;
  while (n < 1_000) n += 0x10 + 0b101;
  print(`${n}`);
});
