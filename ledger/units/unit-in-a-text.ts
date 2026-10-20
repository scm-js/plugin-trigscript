// ledger: step 10, refused: a unit kept in a variable
// A unit's numbers in a printed text: `${u.hp} of ${u.maxHp}`.
program(() => {
  const u = first({ owner: P1 });
  if (u) print(`${u.hp} of ${u.maxHp}`);
});
