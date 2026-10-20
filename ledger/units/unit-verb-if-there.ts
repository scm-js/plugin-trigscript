// ledger: step 10, refused: a unit kept in a variable
// A verb on a unit kept in a variable that may be none: `u?.kill()`.
program(() => {
  const u = first({ owner: P1 });
  u?.kill();
});
