// ledger: step 10, refused: a unit kept in a variable
// A function that takes a unit: `function hurt(u: Unit, n: number)`.
function hurt(u: Unit, n: number) {
  u.damage(n);
}
program(() => {
  const u = first({ owner: P1 });
  if (u) hurt(u, 10);
});
