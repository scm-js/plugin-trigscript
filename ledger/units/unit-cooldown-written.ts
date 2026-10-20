// ledger: step 10, refused: a unit's cooldown written
// A unit's weapon cooldown, written, holding its fire that many frames: `u.cooldown = 48`.
program(() => {
  first({ owner: P1 })!.cooldown = 48;
});
