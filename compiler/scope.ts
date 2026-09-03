/**
 * The structured program's scopes: a binding per declaration node (a constant, or a
 * variable in the machine), looked up through the parents. Its own module so the
 * compiler and the structured walker can both import it without importing each other —
 * the editor's plugin loader follows imports and refuses a cycle.
 */
import type * as TS from "typescript";
import type { Var } from "./lower";

export type Const = { n: number } | { s: string };

/** What an identifier means inside structured code: a constant (function parameter) or a variable. */
export type Binding = { kind: "const"; value: Const } | { kind: "var"; v: Var };

/** Bindings keyed by declaration node, so shadowing and inlined functions resolve exactly as the checker does. */
export class Scope {
  private readonly map = new Map<TS.Node, Binding>();
  readonly parent: Scope | null;
  constructor(parent: Scope | null) { this.parent = parent; }
  bind(decl: TS.Node, b: Binding) { this.map.set(decl, b); }
  lookup(decl: TS.Node): Binding | undefined {
    return this.map.get(decl) ?? this.parent?.lookup(decl);
  }
}
