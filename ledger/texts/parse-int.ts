// ledger: step 8, takes
// The whole number written at the start of a text: `parseInt(s)`, and `isNaN(parseInt(s))` for whether there is one.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if (isNaN(parseInt(n > 10 ? " 42 ore" : "none"))) print("no number");
  else print(`${parseInt(n > 10 ? " 42 ore" : "none")}`);
});
