/**
 * The structured program's scopes: a binding per declaration node (a value computed
 * when the script was built, or a variable in the machine), looked up through the
 * parents. Its own module so the compiler and the structured walker can both import it
 * without importing each other — the editor's plugin loader follows imports and refuses
 * a cycle.
 */
import type * as TS from "typescript";
import type { Var } from "./lower";

/**
 * What an identifier means inside a program: a build-time value (a parameter bound to
 * one), a variable, or a record — `let p = { lives: 3, alive: true }` — whose fields are
 * bindings of their own (`p.lives` is a death counter like any `let`).
 */
export type Binding = { kind: "value"; value: unknown } | { kind: "var"; v: Var } | { kind: "record"; fields: Map<string, Binding> };

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
