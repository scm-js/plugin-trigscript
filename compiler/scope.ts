import type * as TS from "typescript";
import type { ArrayDecl, NumExpr, VarDecl } from "./ir";

/** What a declaration of the body is bound to while it is walked: a build-time value, a variable of the program, or a record of bindings. */
export type Binding =
  | { kind: "value"; value: unknown }
  | { kind: "var"; v: VarDecl }
  /** An array of the program: `let hp = [0, 0, 0]`, or a list known when the script was built that a program indexes with a variable. */
  | { kind: "array"; a: ArrayDecl }
  /** One cell of an array, where a variable could stand: a field of `waves[i]`, read and stored through the array. */
  | { kind: "cell"; a: ArrayDecl; index: NumExpr }
  /**
   * An array of records — `let waves = [{ count: 4, delay: 2 }]` — which is an array a field, all of one length and
   * growing together. `waves[i]` is a record of cells, so what is written through it is written into the array, as an
   * object of a TypeScript array is a reference.
   */
  | { kind: "records"; name: string; fields: Map<string, ArrayDecl> }
  /** An array of units: three arrays of numbers — where each unit is, the same as an EPD, and its slot's uniqueness byte — moving together. */
  | { kind: "units"; name: string; ptr: ArrayDecl; epd: ArrayDecl; uid: ArrayDecl }
  /**
   * A table keyed by an id of the game — `Record<UnitType, number>`, `Map<Player, number>`, `Set<UnitType>` — which is an
   * array with a cell for every id there is. `values` is absent for a Set; `present` says which keys were set (absent for
   * a Record, whose every key reads its value or 0); `size` counts them. `as` is how the source reaches it.
   */
  | { kind: "keyed"; as: "record" | "map" | "set"; name: string; domain: number; key: string; values?: ArrayDecl; present?: ArrayDecl; size?: VarDecl }
  /** `truth`: the record stands for something that may not be there (what `chatted()` found): the boolean that says whether it is. */
  | { kind: "record"; fields: Map<string, Binding>; truth?: VarDecl };

export class Scope {
  private readonly map = new Map<TS.Node, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) { this.parent = parent; }
  bind(decl: TS.Node, b: Binding) { this.map.set(decl, b); }
  lookup(decl: TS.Node): Binding | undefined {
    return this.map.get(decl) ?? this.parent?.lookup(decl);
  }
}
