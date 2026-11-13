// ledger: step 10, takes
// How far a unit has got with its order: `u.orderState`.
program(() => {
  print(`${first({ owner: P1 })!.orderState}`);
});
