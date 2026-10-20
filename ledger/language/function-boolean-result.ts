// ledger: step 1, takes
// A function that returns a boolean, called from more than one place and tested.
function isBig(n: number): boolean {
  return n > 5;
}
program(() => {
  let n = 0;
  let count = 0;
  while (n < 9) {
    if (isBig(n)) count += 1;
    if (isBig(n + 3)) count += 10;
    n += 1;
  }
  print(`${count}`);
});
