// ledger: step 10, takes
// A unit's hit points written from a value of the program: `u.hp = n`.
program(() => {
  let n = 5;
  while (n < 40) n += 7;
  first({ owner: P1 })!.hp = n;
});
