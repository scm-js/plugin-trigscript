// ledger: step 8, refused: a function that gives back a text (label)
// A function of the script that takes a text and gives one back: `label(name, n)`.
function label(name: string, n: number): string {
  return `${name} x${n}`;
}
program(() => {
  let n = 0;
  while (n < 12) n += 5;
  print(label(n > 10 ? "Medic" : "Marine", n));
});
