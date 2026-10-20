// ledger: step 11, refused: an event handled (on.died)
// Every unit that dies or is removed, handed to a function as it was: `on.died((u) => …)`.
program(async () => {
  let n = 0;
  on.died((u) => {
    n += 1;
    print(`${n}`);
  });
});
