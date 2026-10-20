// ledger: step 7, takes
// A program that runs once for each player at the same time, each with their own variables: `{ owner: AllPlayers }`.
program(() => {
  let n = 0;
  while (n < 3) n += 1;
  print(`${n}`);
}, { owner: AllPlayers });
