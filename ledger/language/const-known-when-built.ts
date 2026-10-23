// ledger: step 0, takes
// A `const` whose value is known when the map is built: worked out then, and used as that number.
const WAVES = 4;
const PER_WAVE = WAVES * 5 + 2;
program(() => {
  let left = PER_WAVE;
  left -= 1;
  print(`${left}`);
});
