// ledger: step 11, refused: a map of our own has no per-player program yet
// Each player's own tasks in a program for every player: `start(…)` with `{ owner: AllPlayers }`.
async function hello(n: number) {
  await sleep(frames(n));
  print(`hello ${n}`);
}
program(async () => {
  start(hello(2));
}, { owner: AllPlayers });
