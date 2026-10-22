// ledger: step 11, refused: try
// `finally`: what runs however the `try` is left.
program(() => {
  let k = 0;
  let cleaned = 0;
  while (k < 3) {
    try {
      if (k == 1) break;
    } finally {
      cleaned += 1;
    }
    k += 1;
  }
  print(`${cleaned}`);
});
