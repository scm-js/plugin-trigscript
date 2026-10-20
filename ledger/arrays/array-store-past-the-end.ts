// ledger: step 3, takes
// A store at a place past an array's end, which stores nothing (and is said when the script is tested).
program(() => {
  const hp = [10, 20, 30];
  let i = 0;
  while (i < 5) i += 2;
  hp[i] = 99;
  print(`${hp[0] + hp[1] + hp[2]}`);
});
