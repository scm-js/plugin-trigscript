// ledger: step 10, refused: a unit's verb (kill)
// A function that gives back a unit or none: `function pick(): Unit | null`.
function pick(): Unit | null {
  return first({ owner: P2, type: units.ZergZergling });
}
program(() => {
  pick()?.kill();
});
