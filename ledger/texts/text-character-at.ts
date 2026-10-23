// ledger: step 8, takes
// One character of a text, at a place that changes while the game runs: `s[i]`, `s.charAt(i)`, `s.at(-1)`.
program(() => {
  let i = 0;
  while (i < 6) i += 4;
  const s = "Terran Marine";
  print(`${s[i]}${s.charAt(i + 1)}${s.at(-1)}`);
});
