// ledger: step 10, takes
// A variable that holds a unit or none, none to begin with: `let u: Unit | null = null`.
program(() => {
  let u: Unit | null = null;
  if (u) print("there");
  u = first({ owner: P1 });
  if (u) print("found");
});
