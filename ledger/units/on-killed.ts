// ledger: step 11, refused: an event handled (on.killed)
// Every unit killed in a fight, with the player whose attack killed it: `on.killed((u, by) => …)`.
program(async () => {
  on.killed((u, by) => {
    if (by == P1) print("P1 got one");
  });
});
