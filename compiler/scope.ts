import type * as TS from "typescript";
import type { VarDecl } from "./ir";

/** What a declaration of the body is bound to while it is walked: a build-time value, a variable of the program, or a record of bindings. */
export type Binding =
  | { kind: "value"; value: unknown }
  | { kind: "var"; v: VarDecl }
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
