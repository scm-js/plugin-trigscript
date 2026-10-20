// ledger: step 11, refused: an event handled (on.created)
// The units that come onto the map that a filter matches: `on.created({ owner: P2 }, (u) => …)`.
program(async () => {
  on.created({ owner: P2 }, (u) => {
    u.invincible = true;
  });
});
