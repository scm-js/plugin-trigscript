// ledger: step 11, takes
// An error thrown at the bottom of a function that calls itself, caught around the first call: up through every frame.
function down(n: number): number {
  if (n == 0) throw new Error("bottom");
  return down(n - 1) + 1;
}
program(() => {
  let k = 0;
  while (k < 2) k += 1;
  try {
    print(`${down(k + 3)}`);
  } catch {
    print("caught at the top");
  }
});
