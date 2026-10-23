// ledger: step 4, takes
// `a ** n` and `Math.pow(a, n)` by a power known when the script is built; `Math.sign` and `Math.log2` (of a whole number: rounded down).
program(() => {
  let a = 3;
  let b = -7;
  let c = 1000;
  print(`${a ** 2} ${Math.pow(a, 3)} ${(a + 1) ** 0} ${Math.sign(a)} ${Math.sign(b)} ${Math.sign(a - a)} ${Math.log2(c)}`);
});
