// ledger: step 10, takes
// A function that takes a unit: `function hurt(u: Unit, n: number)`.
function hurt(u: Unit, n: number) {
  u.damage(n);
}
program(() => {
  const u = first({ owner: P1 });
  if (u) hurt(u, 10);
});
