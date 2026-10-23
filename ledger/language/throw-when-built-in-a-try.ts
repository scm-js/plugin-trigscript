// ledger: step 11, takes
// A call worked out when the script is built that throws, inside a try: the program's error, which the catch takes.
function check(n: number) {
  if (n > 5) throw new RangeError("too big: " + n);
  return n;
}
program(() => {
  let total = 0;
  try {
    total += check(9);
  } catch (e) {
    total = e instanceof RangeError ? -1 : -2;
  }
  print(`${total}`);
});
