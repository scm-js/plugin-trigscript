// ledger: step 10, takes
// Units kept in a fixed-length array: `const pair: (Unit | null)[] = [a, b]`.
program(() => {
  const pair: (Unit | null)[] = [first({ owner: P1 }), first({ owner: P2 })];
  for (const u of pair) if (u) u.heal(5);
});
