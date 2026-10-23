// ledger: step 3, takes
// A cell read at a place past an array's end, which reads 0 (and is said when the script is tested).
program(() => {
  const hp = [10, 20, 30];
  hp[0] = 5;
  let i = 0;
  while (i < 5) i += 2;
  print(`${hp[i]}`);
});
