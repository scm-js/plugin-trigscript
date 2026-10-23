// ledger: step 0, takes
// A function whose parameter is destructured: `function area({ w, h }: Size)`.
function area({ w, h }: { w: number; h: number }) {
  return w + h + h;
}
program(() => {
  let s = { w: 2, h: 3 };
  let total = 0;
  while (s.w < 8) {
    total += area(s);
    total += area({ w: 1, h: s.w });
    s.w += 2;
  }
  print(`${total}`);
});
