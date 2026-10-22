// ledger: step 9, takes
// An array that grows, declared in a function that calls itself: each call its own, kept on the stack around the calls it makes.
function depth(n: number): number {
  const seen: number[] = [];
  seen.push(n);
  if (n > 0) seen.push(depth(n - 1));
  return seen.length + seen[0];
}
program(() => {
  let n = 0;
  while (n < 4) n += 1;
  print(`${depth(n)}`);
});
