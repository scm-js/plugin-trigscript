// ledger: step 1, takes
// Two functions that call each other.
function isEven(n: number): boolean {
  if (n == 0) return true;
  return isOdd(n - 1);
}
function isOdd(n: number): boolean {
  if (n == 0) return false;
  return isEven(n - 1);
}
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  if (isEven(n)) print("even");
  else print("odd");
});
