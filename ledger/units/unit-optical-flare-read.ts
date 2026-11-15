// ledger: step 10, takes
// Whether a unit is blinded by Optical Flare: `u.opticalFlare`.
program(() => {
  if (first({ owner: P1 })?.opticalFlare) print("blind");
});
