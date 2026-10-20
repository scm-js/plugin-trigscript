// ledger: step 3, takes
// An array handed to a function of the script, which reads and stores into the array itself.
function bump(xs: number[], i: number) {
  xs[i] += 10;
}
program(() => {
  const xs = [1, 2, 3];
  let i = 0;
  while (i < 2) {
    bump(xs, i);
    i += 1;
  }
  print(`${xs[0] + xs[1]}`);
});
