// ledger: step 6, refused: a write of unit.maxShields
// A unit type's shield points written.
program(() => {
  stats(units.ProtossZealot).maxShields = 80;
});
