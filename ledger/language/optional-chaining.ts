// ledger: step 9, refused: a warning TrigScript shows every player ("more than 1023 closures and their variables are kept at once")
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
