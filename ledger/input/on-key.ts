// ledger: step 12, refused: the players' input (key)
// A function run each time a player presses a key: `on.key("F7", (p) => …)`.
program(async () => {
  on.key("F7", (p) => {
    print("help");
  });
});
