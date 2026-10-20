// ledger: step 12, refused: an event handled (on.key)
// A function run each time a player presses a key: `on.key("F7", (p) => …)`.
program(async () => {
  on.key("F7", (p) => {
    print("help");
  });
});
