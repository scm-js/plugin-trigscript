// ledger: step 0, takes
// A generator method, `*[Symbol.iterator]()`: an instance walked by `for…of`.
class Squad {
  size = 3;
  *[Symbol.iterator]() {
    let i = 0;
    while (i < this.size) {
      yield i;
      i += 1;
    }
  }
}
program(() => {
  const s = new Squad();
  while (s.size < 5) s.size += 1;
  let total = 0;
  for (const x of s) total += x;
  print(`${total}`);
});
