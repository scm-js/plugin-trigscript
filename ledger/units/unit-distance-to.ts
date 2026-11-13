// ledger: step 10, takes
// How far apart two units are, edge to edge, as the game measures a range: `a.distanceTo(b)`.
program(() => {
  const a = first({ owner: P1 }), b = first({ owner: P2 });
  if (a) if (b) if (a.distanceTo(b) <= 192) print("in range");
});
