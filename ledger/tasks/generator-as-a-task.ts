// ledger: step 11, refused: a task started
// A generator walked inside a task started beside the program.
function* steps() {
  yield 1;
  yield 2;
  yield 3;
}
async function walkSteps() {
  for (const s of steps()) {
    print(`step ${s}`);
    await sleep(frames(1));
  }
}
program(async () => {
  start(walkSteps());
});
