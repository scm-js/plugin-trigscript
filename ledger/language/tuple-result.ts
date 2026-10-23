// ledger: step 3, takes
// A function that returns two numbers as a tuple, `return [a, b] as const`, destructured where it is called.
function split(n: number) {
  return [n + 1, n + 2] as const;
}
program(() => {
  let n = 0;
  while (n < 4) n += 1;
  const [a, b] = split(n);
  print(`${a} ${b}`);
});
