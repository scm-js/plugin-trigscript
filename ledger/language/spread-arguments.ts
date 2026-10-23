// ledger: step 0, takes
// Arguments spread from a list known when the map is built: `mix(n, ...PAIR)`.
function mix(a: number, b: number, c: number) {
  return a + b + b + c;
}
const PAIR = [3, 4] as const;
program(() => {
  let n = 0;
  let turns = 0;
  while (turns < 3) {
    n = mix(n, ...PAIR);
    turns += 1;
  }
  print(`${n}`);
});
