// ledger: step 7, takes
// A program run for every player, `{ owner: AllPlayers }`: `CurrentPlayer` is the one it is running for.
program(
  () => {
    let n = 0;
    while (n < 3) n += 1;
    print(`${n}`, { to: CurrentPlayer });
  },
  { owner: AllPlayers },
);
