// ledger: step 10, takes
// How fast a unit is moving now, in 256ths of a pixel a frame: `u.speed`, 0 standing still.
program(() => {
  const u = first({ owner: P1 });
  if (u && u.speed > 0) print(`moving at ${u.speed / 256}`);
});
