// ledger: step 3, takes
// An array of a fixed length spread into a call's arguments: `f(...xs)`.
function sum3(a: number, b: number, c: number): number {
  return a + b + c;
}
program(() => {
  const xs: [number, number, number] = [1, 2, 3];
  let v = 0;
  while (v < 10) v += 3;
  xs[1] = v;
  print(`${sum3(...xs)}`);
});
