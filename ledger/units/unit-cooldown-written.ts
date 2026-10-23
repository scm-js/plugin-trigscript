// ledger: step 10, takes
// A unit's weapon cooldown, written, holding its fire that many frames: `u.cooldown = 48`.
program(() => {
  first({ owner: P1 })!.cooldown = 48;
});
