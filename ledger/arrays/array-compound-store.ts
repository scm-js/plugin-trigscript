// ledger: step 3, takes
// A cell of an array changed where it is: `hp[i] += 5`, `hp[i]++`.
program(() => {
  const hp = [10, 20, 30];
  let i = 0;
  while (i < 3) {
    hp[i] += 5;
    hp[i]++;
    i += 1;
  }
  print(`${hp[1]}`);
});
