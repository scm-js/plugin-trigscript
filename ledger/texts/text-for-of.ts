// ledger: step 8, takes
// A loop over the characters of a text: `for (const ch of s)`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  let vowels = 0;
  for (const ch of n > 10 ? "Medic" : "Marine") if (ch === "a" || ch === "e" || ch === "i") vowels += 1;
  print(`${vowels}`);
});
