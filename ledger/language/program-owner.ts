// ledger: step 7, takes
// A program run as another player than the first: `program(…, { owner: P3 })`.
program(
  () => {
    let n = 0;
    while (n < 3) n += 1;
    print(`${n}`);
  },
  { owner: P3 },
);
