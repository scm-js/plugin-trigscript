// ledger: step 11, takes
// The units one player kills of another's: `on.killed({ owner: P8, by: P1 }, (u, by) => …)`.
program(async () => {
  on.killed({ owner: P8, by: P1 }, (u, by) => {
    setResources(by, "add", 25, "ore");
  });
});
