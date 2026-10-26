// ledger: step 5, takes
// `?.` reading a number through an instance that may be `null`: `a?.v ?? 0`.
class Node {
  constructor(public v: number) {}
}
program(() => {
  let a: Node | null = null;
  let k = 0;
  let total = 0;
  while (k < 4) {
    if (k == 2) a = new Node(k);
    total += a?.v ?? 10;
    k += 1;
  }
  print(`${total}`);
});
