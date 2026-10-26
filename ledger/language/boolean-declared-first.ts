// ledger: step 7, takes
// A program whose first statement declares a boolean false, tested before it changes: `let done = false; if (!done) …`.
program(() => {
  let done = false;
  if (!done) print("not yet");
  done = true;
  if (done) print("done");
});
