// ledger: step 12, takes
// A number read out of a typed line: `const m = chatted(P1, "-give {n}"); if (m) … m.n …`.
program(async () => {
  while (true) {
    const m = chatted(P1, "-give {n}");
    if (m) print(`${m.n}`);
    await nextFrame();
  }
});
