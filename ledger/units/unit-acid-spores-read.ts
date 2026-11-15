// ledger: step 10, takes
// Acid spores on a unit, read: `u.acidSpores`.
program(() => {
  print(`${first({ owner: P1 })!.acidSpores}`);
});
