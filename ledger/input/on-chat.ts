// ledger: step 12, refused: the players' input (chat)
// A function run each time a player types a line that fits a pattern: `on.chat("-give {n}", (p, { n }) => …)`.
program(async () => {
  on.chat("-give {n}", (p, { n }) => {
    setResources(p, "add", n, "ore");
  });
});
