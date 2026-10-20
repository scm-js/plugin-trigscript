// ledger: step 0, takes
// A `static` field and a `static` method: one for the class, shared by every instance.
class Id {
  static next = 1;
  id = 0;
  constructor() {
    this.id = Id.next;
    Id.next++;
  }
  static made() {
    return Id.next - 1;
  }
}
program(() => {
  const a = new Id();
  const b = new Id();
  let k = 0;
  while (k < 3) {
    Id.next += 1;
    k += 1;
  }
  print(`${a.id} ${b.id} ${Id.made()}`);
});
