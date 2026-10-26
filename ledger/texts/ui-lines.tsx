// ledger: step 11, takes
// A text kept in a player's text lines and shown again as the program's variables change: `ui.lines(P1, () => …)`.
program(async () => {
  let score = 0;
  ui.lines(P1, () => <line>Score {score}</line>);
  while (score < 30) {
    await sleep(frames(1));
    score += 10;
  }
});
