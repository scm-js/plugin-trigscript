// ledger: step 11, takes
// `e.stack`: the error's class, message and the line it was thrown at, made where it is thrown because it is read.
function check(n: number) {
  if (n > 1) throw new RangeError(`n is ${n}`);
}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    check(k);
  } catch (e) {
    if (e instanceof Error) print(e.stack ?? "");
  }
});
