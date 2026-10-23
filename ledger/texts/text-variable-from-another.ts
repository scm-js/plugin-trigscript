// ledger: step 8, takes
// A text variable given another's text, both only ever holding texts the script wrote: `let b = a`, then compared.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  let a = "north";
  if (n > 10) a = "south";
  let b = "east";
  if (n > 3) b = a;
  if (a === b) print(`${b} both`);
});
