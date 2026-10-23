// ledger: step 8, takes
// A `switch` over a text, its cases texts: `switch (unit) { case "Marine": … }`.
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  switch (n > 10 ? "Medic" : "Marine") {
    case "Marine":
      print("50 ore");
      break;
    case "Medic":
      print("75 ore");
      break;
    default:
      print("?");
  }
});
