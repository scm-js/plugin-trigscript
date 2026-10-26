// ledger: step 10, takes
// A loop over units left early: `break` at the first unit that is hurt.
program(() => {
  let found = false;
  for (const u of unitsOf(P1)) {
    if (u.hp < u.maxHp) {
      found = true;
      break;
    }
  }
  if (found) print("hurt");
});
