// ledger: step 0, takes
// A number the script works out from numbers written in it, when the map is built: `const SIZE = (64 * 4 + 2) / 3 % 50`.
const SIZE = ((64 * 4 + 2) / 3) % 50;
program(() => {
  let n = 0;
  while (n < SIZE) n += 4;
  print(`${n}`);
});
