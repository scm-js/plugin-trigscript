// ledger: step 0, takes
// A generator, `function*`, walked by `for…of`: the loop's body put where each `yield` is.
function* upTo(n: number) {
  let i = 0;
  while (i < n) {
    yield i;
    i += 1;
  }
}
program(() => {
  let end = 0;
  while (end < 5) end += 1;
  let total = 0;
  for (const x of upTo(end)) total += x;
  print(`${total}`);
});
