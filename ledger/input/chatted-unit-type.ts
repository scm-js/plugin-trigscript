// ledger: step 12, takes
// A unit type read out of a typed line by its name: `chatted(P1, "-spawn {what:unit}")`.
program(async () => {
  while (true) {
    const m = chatted(P1, "-spawn {what:unit}");
    if (m && m.what == units.TerranMarine) print("a marine");
    await nextFrame();
  }
});
