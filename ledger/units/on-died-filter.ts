// ledger: step 11, refused: an event handled (on.died)
// The units that die that a filter matches, as they died: `on.died({ owner: P8 }, (u) => …)`.
program(async () => {
  on.died({ owner: P8 }, (u) => {
    if (u.type == units.ZergZergling) print("a zergling");
  });
});
