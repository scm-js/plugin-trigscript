// ledger: step 11, takes
// The units of one type that come onto the map: `on.created(units.ZergZergling, (u) => …)`.
program(async () => {
  on.created(units.ZergZergling, (u) => {
    u.hp = 10;
  });
});
