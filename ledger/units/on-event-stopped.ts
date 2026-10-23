// ledger: step 11, takes
// An event's listening stopped by the task it gives back: `const t = on.created(…); t.cancel()`.
program(async () => {
  const t = on.created((u) => {
    u.kill();
  });
  await sleep(seconds(10));
  t.cancel();
});
