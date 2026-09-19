import type * as TS from "typescript";
import type { ArrayDecl, FuncDecl, NumExpr, VarDecl } from "./ir";

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
  | { kind: "records"; name: string; fields: Map<string, ArrayDecl>; cls?: TS.ClassDeclaration; shape?: RowShape }
  /** A unit kept as its three numbers, each somewhere a number can be: a field of a row (`squads[i].leader`), or of a row held in temporaries. */
  | { kind: "unitAt"; ptr: Place; epd: Place; uid: Place }
  /** A text kept in cell `index` of three arrays: a row's (`waves[i].name`). */
  | { kind: "textAt"; addr: ArrayDecl; block: ArrayDecl; chars: ArrayDecl; index: NumExpr }
  /** `squads[i].members` before anything needs it as an array of units: a row of each of the three arrays of arrays that grow. */
  | { kind: "innerUnits"; name: string; ptr: Extract<Binding, { kind: "lists" }>; epd: Extract<Binding, { kind: "lists" }>; uid: Extract<Binding, { kind: "lists" }>; index: NumExpr }
  /** An array of units: three arrays of numbers — where each unit is, the same as an EPD, and its slot's uniqueness byte — moving together. */
  | { kind: "units"; name: string; ptr: ArrayDecl; epd: ArrayDecl; uid: ArrayDecl }
  /**
   * A table keyed by an id of the game — `Record<UnitType, number>`, `Map<Player, number>`, `Set<UnitType>` — which is an
   * array with a cell for every id there is. `values` is absent for a Set; `present` says which keys were set (absent for
   * a Record, whose every key reads its value or 0); `size` counts them. `as` is how the source reaches it.
   */
  | { kind: "keyed"; as: "record" | "map" | "set"; name: string; domain: number; key: string; values?: ArrayDecl; present?: ArrayDecl; size?: VarDecl }
  /**
   * A `Map` or a `Set` over any number: the entries in the order they went in — `keys`, `values` (a Map's), `live` (false
   * once deleted) — and `slots`, the table a key is found through: a power of two of cells, each 0 or an entry's place
   * plus one. `used` counts the slots taken since the table was last made, `dead` the entries deleted and still there,
   * `walking` the loops going through it now. `fns` are its functions, made when first needed.
   */
  | { kind: "hash"; as: "map" | "set"; name: string; slots: ArrayDecl; keys: ArrayDecl; values?: ArrayDecl; live: ArrayDecl; size: VarDecl; mask: VarDecl; used: VarDecl; dead: VarDecl; walking: VarDecl; fns: { find?: FuncDecl; place?: FuncDecl; grow?: FuncDecl; put?: FuncDecl; drop?: FuncDecl } }
  /**
   * An array of arrays whose shape is known when the script is built — `let grid = [[0, 0, 0], [0, 0, 0]]` — which is one
   * flat array: `dims` are its sizes from the outside in (the first is 0 when the outer array grows, by whole rows), and
   * `offset` is where this part of it starts, for the part of a deeper one that `cube[z]` is.
   */
  | { kind: "grid"; name: string; a: ArrayDecl; dims: number[]; offset: NumExpr | null }
  /**
   * `grid[y]` before anything needs it as an array: `length` cells of `a` from `offset`. Reading `grid[y][x]` goes straight
   * to the flat array; what wants an array (a loop, a method, a function it is handed to) makes it a window (`ArrayDecl.slice`).
   */
  | { kind: "row"; name: string; a: ArrayDecl; offset: NumExpr; length: number }
  /**
   * An array of arrays that grow — rows of different lengths, a row something pushes to: four arrays, a handle a row
   * (where the row's block is in the heap, the cells in use, its room, its size class). `of` is what the rows hold.
   */
  | { kind: "lists"; name: string; ptr: ArrayDecl; len: ArrayDecl; room: ArrayDecl; k: ArrayDecl; of: "number" | "boolean"; bits?: 8 | 16; unsigned?: boolean }
  /** `buckets[i]` before anything needs it as an array: the row at `index`, which becomes an `ArrayDecl.through` where it is used. */
  | { kind: "inner"; lists: Extract<Binding, { kind: "lists" }>; index: NumExpr }
  /**
   * `truth`: the record stands for something that may not be there (what `chatted()` found): the boolean that says whether it is.
   * `cls`: the record is an instance — `new Squad()` — and this is its class, known when the script is built, which is what a
   * method call, a getter, `instanceof` and an overridden method are settled by.
   */
  | { kind: "record"; fields: Map<string, Binding>; truth?: VarDecl; cls?: TS.ClassDeclaration };

/** What `this` is bound under in the scope of a method's body: no declaration of the source stands for it. */
export const THIS = { kind: -1 } as unknown as TS.Node;

/** Where one number is kept: a cell of an array, or a variable. */
export type Place = { a: ArrayDecl; index: NumExpr } | { v: VarDecl };

/**
 * What a row of an array of records holds, by field, when it is more than numbers and booleans. Every field is one or
 * more plain arrays of the binding's `fields` — *columns*, which is what lets a push, a pop, a sort move a row as a
 * whole without knowing what is in it. A column's key is the path to it, its parts joined by a space, which no field's
 * name can hold: `hp`, `leader ptr`, `seen block`, `name addr`, `pos x`, `members epd length`.
 */
export type RowShape = Map<string, RowField>;
export type RowField =
  | { kind: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }
  /** A unit: `ptr`, `epd`, `uid`. */
  | { kind: "unit" }
  /** An array that grows, its handle the row's: `block`, `length`, `room`, `size`. The row owns the block. */
  | { kind: "list"; of: "number" | "boolean"; width: { bits?: 8 | 16; unsigned?: boolean } }
  /** An array of units that grows: a handle for each of a unit's three numbers. */
  | { kind: "squad" }
  /** A text: `addr`, `block`, `chars` — where it is, the block of the heap it owns (0 for one of the map's table), its length. The row owns the block. */
  | { kind: "text" }
  /** A record, or an instance, inside the row: its fields' columns under its name. */
  | { kind: "record"; shape: RowShape; cls?: TS.ClassDeclaration };

/** The parts of a unit, and of an array's handle, in the order their columns are kept. */
export const UNIT_PARTS = ["ptr", "epd", "uid"] as const;
export const HANDLE_PARTS = ["block", "length", "room", "size"] as const;
export const TEXT_PARTS = ["addr", "block", "chars"] as const;

export class Scope {
  private readonly map = new Map<TS.Node, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) { this.parent = parent; }
  bind(decl: TS.Node, b: Binding) { this.map.set(decl, b); }
  lookup(decl: TS.Node): Binding | undefined {
    return this.map.get(decl) ?? this.parent?.lookup(decl);
  }
}
