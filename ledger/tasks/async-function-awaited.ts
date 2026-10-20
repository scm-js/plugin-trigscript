// ledger: step 1, takes
// An async function, awaited: it waits where it sleeps, and the program goes on after it.
async function pause(n: number) {
  await sleep(frames(n));
}
program(async () => {
  await pause(3);
  print("after");
});
