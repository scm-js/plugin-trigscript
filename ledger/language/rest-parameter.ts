// ledger: step 3, takes
// A rest parameter, `...xs: number[]`: the arguments a call gives, however many, as a fixed-length array.
function sum(...xs: number[]) {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
program(() => {
  let a = 1;
  let b = 2;
  let turns = 0;
  while (turns < 3) {
    a = sum(a, b, 1);
    b = sum(b, a);
    turns += 1;
  }
  print(`${a} ${b}`);
});
