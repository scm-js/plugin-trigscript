// ledger: step 0, takes
// A type alias of a union of numbers, `type Lane = 0 | 1 | 2`: a type only, the values numbers.
type Lane = 0 | 1 | 2;
program(() => {
  let lane: Lane = 0;
  let turns = 0;
  while (turns < 5) {
    lane = lane == 2 ? 0 : lane == 1 ? 2 : 1;
    turns += 1;
  }
  print(`${lane}`);
});
