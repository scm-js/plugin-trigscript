// ledger: step 1, takes
// A function that calls itself: each call has its own parameters and locals, kept on a stack.
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  print(`${fib(n)}`);
});
