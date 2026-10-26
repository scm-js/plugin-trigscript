// ledger: step 11, takes
// Every unit that comes onto the map, handed to a function in the next frame: `on.created((u) => …)`.
program(async () => {
  on.created((u) => {
    u.energy = 50;
  });
});
