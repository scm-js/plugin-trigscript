// ledger: step 7, takes
// An array every player of a program for several players shares: `const seen = shared([0, 0, 0, 0])`.
program(() => {
  const seen = shared([0, 0, 0, 0]);
  seen[0] += 1;
  print(`${seen[0]}`);
}, { owner: AllPlayers });
