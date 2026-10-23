// ledger: step 11, takes
// A function that calls itself past the stack's depth throws a RangeError, as JavaScript's does, which a `catch` takes.
function deep(n: number): number {
  if (n > 1000000) return 0;
  return deep(n + 1) + 1;
}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    print(`${deep(k)}`);
  } catch (e) {
    if (e instanceof RangeError) print(e.message);
  }
});
