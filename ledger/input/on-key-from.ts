// ledger: step 12, refused: an event handled (on.key)
// A function run each time one player presses a key: `on.key("Space", (p) => …, { from: P1 })`.
program(async () => {
  let n = 0;
  on.key("Space", (p) => {
    n += 1;
    print(`${n}`);
  }, { from: P1 });
});
