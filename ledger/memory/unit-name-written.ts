// ledger: step 6, refused: a write of unit.name
// The name shown for a unit type, a text known when the map is built: `stats(…).name = "…"`.
program(() => {
  stats(units.TerranMarine).name = "Space Marine";
});
