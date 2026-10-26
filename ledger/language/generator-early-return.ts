// ledger: step 0, takes
// A generator that `return`s before its end: the `for…of` walking it ends there.
function* untilBig(limit: number) {
  let i = 0;
  while (true) {
    if (i > limit) return;
    yield i;
    i += 2;
  }
}
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  let total = 0;
  for (const x of untilBig(n)) total += x;
  print(`${total}`);
});
