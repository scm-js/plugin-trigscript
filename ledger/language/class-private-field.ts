// ledger: step 0, takes
// A `#private` field, and one marked `private`: reached only from the class's own code.
class Bank {
  #gold = 0;
  private spent = 0;
  pay(n: number) {
    this.#gold += n;
    this.spent += 1;
  }
  get gold() {
    return this.#gold - this.spent;
  }
}
program(() => {
  const b = new Bank();
  let k = 0;
  while (k < 4) {
    b.pay(k + 2);
    k += 1;
  }
  print(`${b.gold}`);
});
