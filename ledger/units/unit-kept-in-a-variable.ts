// ledger: step 10, refused: a unit kept in a variable
// A unit kept in a variable, and told something there: `const u = first(…); if (u) u.kill()`.
program(() => {
  const u = first({ owner: P1 });
  if (u) u.kill();
});
