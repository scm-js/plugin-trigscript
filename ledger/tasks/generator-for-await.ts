// ledger: step 1, takes
// An async generator walked by `for await`, waiting between its values.
async function* slowly(n: number) {
  let i = 0;
  while (i < n) {
    await sleep(frames(2));
    yield i;
    i += 1;
  }
}
program(async () => {
  for await (const k of slowly(3)) print(`${k}`);
});
