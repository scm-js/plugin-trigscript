// ledger: step 5, takes
// An instance kept by reference: a variable that may hold one instance or another, or none, chosen while the game runs.
class Node {
  constructor(public v: number) {}
}
program(() => {
  let a: Node | null = null;
  let k = 0;
  while (k < 3) k += 1;
  a = new Node(k);
  print(`${a.v}`);
});
