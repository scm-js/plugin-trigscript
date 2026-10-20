// ledger: step 8, takes
// Whether a text of the program begins or ends with another: `startsWith`, `endsWith`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  if ((n > 10 ? "Medic" : "Marine").startsWith("Me")) print("starts so");
  if ((n > 10 ? "Medic" : "Marine").endsWith("ine")) print("ends so");
});
