// ledger: step 6, refused: a write of unit.speed
// A unit type's top speed in pixels a frame, for units made after: `stats(…).speed = 6`.
program(() => {
  stats(units.TerranMarine).speed = 6;
});
