// ledger: step 8, takes
// A text of the program in a printed text: `` print(`${n > 10 ? "Medic" : "Marine"} ready`) ``.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(`${n > 10 ? "Medic" : "Marine"} ready`);
});
