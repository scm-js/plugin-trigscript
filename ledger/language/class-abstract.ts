// ledger: step 1, takes
// An `abstract` class with an abstract method, and a class that extends it and gives the method a body.
abstract class Shape {
  abstract area(): number;
  doubled() {
    return this.area() + this.area();
  }
}
class Square extends Shape {
  constructor(public side: number) {
    super();
  }
  area() {
    return this.side + this.side + this.side + this.side;
  }
}
program(() => {
  let k = 0;
  while (k < 3) k += 1;
  const s = new Square(k);
  print(`${s.doubled()}`);
});
