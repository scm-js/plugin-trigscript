// ledger: step 8, takes
// `switch` on a text the program holds, its cases texts.
program(() => {
  let n = 0;
  let word = "red";
  while (n < 3) n += 1;
  if (n > 2) word = "blue";
  switch (word) {
    case "red": print("stop"); break;
    case "blue": print("go"); break;
  }
});
