// ledger: step 1, takes
// A generator walked by `for…of`, the loop's body put where each `yield` is.
function* upTo(n: number) {
  let i = 0;
  while (i < n) {
    yield i;
    i += 1;
  }
}
program(() => {
  let s = 0;
  for (const x of upTo(4)) s += x;
  print(`${s}`);
});
