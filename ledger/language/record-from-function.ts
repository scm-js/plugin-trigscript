// ledger: step 0, takes
// A function that returns a record, destructured where it is called.
function split(n: number) {
  return { big: n > 4, half: n >> 1 };
}
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  const { big, half } = split(n);
  if (big) print(`${half}`);
});
