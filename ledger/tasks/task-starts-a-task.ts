// ledger: step 11, takes
// A task that starts a task of its own.
async function inner(n: number) {
  await sleep(frames(n));
  print(`inner ${n}`);
}
async function outer() {
  await sleep(frames(1));
  start(inner(2));
}
program(async () => {
  start(outer());
});
