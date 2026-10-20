// ledger: step 11, refused: try
// An error thrown in a called function, caught by the `try` around the call.
function check(n: number) {
  if (n > 2) throw new Error("too big");
  return n + 1;
}
program(() => {
  let n = 0;
  let total = 0;
  try {
    while (n < 5) {
      total += check(n);
      n += 1;
    }
  } catch {
    print(`stopped at ${n}`);
  }
  print(`${total}`);
});
