// ledger: step 7, takes
// A function that calls itself, in a program for several players: each player's run its own stack.
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
program(() => {
  let n = 0;
  while (n < 7) n += 1;
  print(`${fib(n)}`);
}, { owner: [P1, P2] });
