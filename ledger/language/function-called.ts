// ledger: step 1, takes
// A function called from more than one place: one copy in the map, its number parameter set by each call and its number result read back.
function bonus(n: number) {
  return n + n + 1;
}
program(() => {
  let a = 0;
  while (a < 3) a += 1;
  let b = a + 4;
  a = bonus(a);
  b = bonus(b);
  print(`${a} ${b}`);
});
