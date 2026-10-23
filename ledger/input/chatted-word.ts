// ledger: step 12, takes
// One of a list of words read out of a typed line, as its place in the list: `chatted(P1, "-take {kind:ore|gas}")`.
program(async () => {
  while (true) {
    const m = chatted(P1, "-take {kind:ore|gas}");
    if (m) print(`${m.kind}`);
    await nextFrame();
  }
});
