// ledger: step 11, takes
// An error thrown in a called function that nothing catches: said in red with the line of the `throw`, and the program stops.
function explode(k: number) {
  throw new RangeError(`k is ${k}`);
}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  print("before");
  if (k > 1) explode(k);
  print("after");
});
