// ledger: step 0, takes
// An optional parameter, `extra?: number`, tested for `undefined` inside the function.
function advance(n: number, extra?: number) {
  if (extra !== undefined) return n + extra;
  return n + 1;
}
program(() => {
  let n = 0;
  let turns = 0;
  while (turns < 4) {
    n = advance(n);
    n = advance(n, 10);
    turns += 1;
  }
  print(`${n}`);
});
