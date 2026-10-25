// ledger: step 10, takes
// Whether a unit rides in a transport or a bunker: `u.inTransport`.
program(() => {
  let riding = 0;
  for (const u of unitsOf(P1)) if (u.inTransport) riding += 1;
  print(`${riding} aboard`);
});
