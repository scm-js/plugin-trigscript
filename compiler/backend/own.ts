/**
 * A map of our own, as far as the emitter goes: a compiled script's one program lowered whole by `emitBody`, or why
 * it is not. `scripts/build-own.mts` makes the map from what this gives; the ledger (`tests/ledger.test.ts`) asks it
 * of every feature, so that the two refuse the same.
 */
import type { CompileResult } from "../compiler";
import type { ArrayDecl, FuncDecl, Program, VarDecl } from "../ir";
import { emitBody } from "./emit";
import type { Graph } from "./graph";

export function emitOwn(r: Pick<CompileResult, "ir" | "triggers">): { program: Program; graph: Graph } | string {
  if (r.ir.length !== 1) return `a map of our own has one program; this script has ${r.ir.length}`;
  const program = r.ir[0];
  if (program.perPlayer) return "a map of our own has no per-player program yet";
  // (Its start-up is in the owner's triggers, and the game runs those of P1 to P8 only.)
  if (program.owner >= 8) return `a program owned by P${program.owner + 1}: a map of our own starts a program from its owner's triggers, which the game runs for P1 to P8 only`;
  // (A map of our own is built without the map's triggers, so `trigger()` records would be lost without a word.)
  if (r.triggers.length) return `a map of our own keeps no trigger() or hyperTriggers() records yet; this script has ${r.triggers.length}`;
  const decls = new Map<string, VarDecl>();
  const collect = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(collect);
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.decl && typeof o.decl === "object" && "id" in (o.decl as object)) decls.set((o.decl as VarDecl).id, o.decl as VarDecl);
      for (const v of Object.values(o)) if (v && typeof v === "object") collect(v);
    }
  };
  collect(program);
  const functions = new Map<string, FuncDecl>((program.functions ?? []).map((f) => [f.id, f]));
  const arrays = new Map<string, ArrayDecl>((program.arrays ?? []).map((a) => [a.id, a]));
  const graph = emitBody(program.body, decls, "own", functions, arrays, undefined, program.owner);
  return typeof graph === "string" ? graph : { program, graph };
}
