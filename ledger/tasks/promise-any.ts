// ledger: step 11, refused: Promise.race
// `Promise.any`, the same as a race (nothing in a program fails): `await Promise.any([…])`.
program(async () => {
  let n = 0;
  const ok = await Promise.any([until(() => n >= 9).then(() => false), sleep(frames(2)).then(() => true)]);
  if (ok) print("held");
});
