// ledger: step 6, takes
// A unit type's hit points written from a value of the program, for the units made after.
program(() => {
  let hp = 40;
  hp += 5;
  stats(units.TerranMarine).maxHp = hp;
});
