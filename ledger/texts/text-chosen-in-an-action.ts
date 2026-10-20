// ledger: step 8, takes
// A text chosen while the game runs as an action's text: `transmission(n > 10 ? "Report" : "Hold", …)`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  transmission(n > 10 ? "Report" : "Hold", units.TerranMarine, locations.Anywhere, "add", 0, "", 500);
});
