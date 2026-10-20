// ledger: step 7, takes
// Two programs in one map, each with an owner of its own, running side by side.
program(
  () => {
    let n = 0;
    while (n < 3) n += 1;
    print(`${n}`);
  },
  { owner: P7 },
);
program(
  () => {
    let n = 0;
    while (n < 5) n += 1;
    print(`${n}`);
  },
  { owner: P8 },
);
