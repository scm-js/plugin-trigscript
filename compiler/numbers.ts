/**
 * What each number of a program is read as. A `number` is a signed 32-bit integer and a `u32`
 * the same 32 bits from 0 up; + − × and the bitwise operators give the same bits either way, so
 * the type matters in five places only — a comparison, ÷ and %, a shift right, min and max, and
 * a printed number — and this pass, run over the IR the front end emitted, writes into each of
 * those which reading it takes (`unsigned`). The two backends (`python/trigscript.py`,
 * `simulateIr.ts`) then never work a type out: they do what the node says.
 *
 * Three more things are settled here, since this is where the types are known:
 *
 * - **Mixing.** A `number` and a `u32` in one piece of arithmetic is an error naming `u32(x)` and
 *   `i32(x)`; a whole-number constant that fits is either. A comparison between the two is not an
 *   error: it is marked with the side that is the `u32` and computed exactly.
 * - **Casts go.** `u32(x)`, `i32(x)` and `x >>> 0` say how the bits are read and compute
 *   nothing, so once the reading is written into the operations around them they are removed.
 * - **Where the game takes nothing below zero** — a `u8` / `u16`, a unit's field, a table's
 *   cell, an action's amount, `random(n)`'s bound, a place on the map — a signed value that
 *   could be below zero is wrapped in `max(v, 0)`. What can be seen never to be (a read, a
 *   `u8`, `x & 0xff`) is left alone, and a comparison of two such sides is marked unsigned,
 *   which costs the lowering nothing where a signed one costs an addition a side. A variable
 *   is such a value when everything ever stored into it is: `let n = minerals(P1)` and what
 *   `chatted()` read are, `wave += 1` is not (it wraps, in the end). That is found first, by
 *   going over the program once without changing it and dropping variables until none is left
 *   that some store could put below zero.
 */
import { I32_MAX, UNIT_FLAGS, declarations, type At, type BoolExpr, type Call, type NumExpr, type Program, type Stmt, type UnitExpr, type VarDecl } from "./ir";
import type { ProgramDiagnostic } from "./eud";

/** `flex`: a constant from 0 to 2 147 483 647, which is the same whichever way it is read. */
type NumType = "i32" | "u32" | "flex";

const FLAGS: ReadonlySet<string> = new Set(UNIT_FLAGS);

export function typeNumbers(program: Program): ProgramDiagnostic[] {
  const errors: ProgramDiagnostic[] = [];
  /** The signed variables nothing ever puts below zero, and every store the program makes, from which they are found. */
  const never = new Set<string>();
  const stores: [string, NumExpr][] = [];
  let settled = false;
  const decls = new Map<string, VarDecl>(declarations(program.body).map((d) => [d.id, d]));
  const mixed = (at: At, what: string) => errors.push({ at, message: `${what} mixes a number, which is signed, with a u32. Say which is meant: u32(x) reads a number's 32 bits from 0 up, i32(x) a u32's as a signed number.` });

  /** The type two sides of one operation share; an error when one is signed and the other a `u32`. */
  const unify = (a: NumType, b: NumType, at: At, what: string): NumType => {
    if (a === "flex") return b;
    if (b === "flex" || a === b) return a;
    mixed(at, what);
    return "i32";
  };

  /** Whether a signed value can be seen never to be below zero. */
  const nonNegative = (e: NumExpr): boolean => {
    switch (e.kind) {
      case "const": return e.value >= 0 && e.value <= I32_MAX;
      case "var": return !!decls.get(e.id)?.bits || never.has(e.id);
      case "read": case "unitField": case "tableRead": case "input": case "randomInt": return true;
      case "ternary": return nonNegative(e.whenTrue) && nonNegative(e.whenFalse);
      case "intrinsic": return e.unsigned ? false : e.name === "min" ? e.args.every(nonNegative) : e.name === "max" ? e.args.some(nonNegative) : false;
      case "binary":
        if (e.unsigned) return false;
        switch (e.op) {
          case "&": return nonNegative(e.left) || nonNegative(e.right);
          case "|": case "^": case "/": return nonNegative(e.left) && nonNegative(e.right);
          case "%": case ">>": return nonNegative(e.left);
          case ">>>": return e.right.kind === "const" && e.right.value >= 1 && e.right.value <= 31;
          default: return false;
        }
      case "call": return !!e.call.result?.decl.bits;
      default: return false;
    }
  };

  /** The expression with its operations marked and its casts removed, and what it is read as. */
  const num = (e: NumExpr): [NumExpr, NumType] => {
    switch (e.kind) {
      case "const": return [e, e.value < 0 ? "i32" : e.value > I32_MAX ? "u32" : "flex"];
      case "var": return [e, decls.get(e.id)?.unsigned ? "u32" : "i32"];
      case "cast": {
        // Gone only on the pass that is for good: the first one still has to find it here the second time.
        const inner = num(e.expr)[0];
        if (settled) return [inner, e.to];
        e.expr = inner;
        return [e, e.to];
      }
      case "unary": {
        const [inner, t] = num(e.expr);
        e.expr = inner;
        return [e, t === "u32" ? "u32" : "i32"];
      }
      case "binary": {
        const [left, lt] = num(e.left);
        const [right, rt] = num(e.right);
        e.left = left;
        e.right = right;
        if (e.op === "<<" || e.op === ">>" || e.op === ">>>") {
          // What is shifted decides; the count is a count. `x >>> 0` is JavaScript's own way of writing u32(x).
          if (e.op === ">>>" && right.kind === "const" && right.value === 0) return [settled ? left : e, "u32"];
          if (e.op === ">>" && lt === "u32") e.op = ">>>";
          return [e, lt === "flex" ? "i32" : lt];
        }
        const t = unify(lt, rt, e.at, `This ${e.op === "+" ? "sum" : e.op === "-" ? "difference" : e.op === "*" ? "product" : e.op === "/" || e.op === "%" ? "division" : "operation"}`);
        if ((e.op === "/" || e.op === "%") && t === "u32") e.unsigned = true;
        return [e, t === "flex" ? "i32" : t];
      }
      case "randomInt": e.bound = floor(e.bound, e.at); return [e, "i32"];
      case "unitField": unit(e.unit); return [e, "i32"];
      case "ternary": {
        e.cond = bool(e.cond);
        const [a, at] = num(e.whenTrue);
        const [b, bt] = num(e.whenFalse);
        e.whenTrue = a;
        e.whenFalse = b;
        return [e, unify(at, bt, e.at, "This ? :")];
      }
      case "intrinsic": {
        const typed = e.args.map(num);
        e.args = typed.map(([a]) => a);
        if (e.name === "abs") {
          // A u32 is never below zero: it is its own distance from 0.
          if (typed[0][1] === "u32") return [e.args[0], "u32"];
          return [e, "i32"];
        }
        const t = typed.map(([, x]) => x).reduce((a, b) => unify(a, b, e.at, `Math.${e.name}()`));
        if (t === "u32") e.unsigned = true;
        return [e, t === "flex" ? "i32" : t];
      }
      case "call": call(e.call); return [e, e.call.result?.decl.unsigned ? "u32" : "i32"];
      default: return [e, "i32"];
    }
  };

  /** A number going where the game takes none below zero: `max(v, 0)` unless it is a `u32` or seen never to be below. */
  const floor = (e: NumExpr, at: At, keepConstant = false): NumExpr => {
    const [value, t] = num(e);
    if (!settled || t === "u32" || nonNegative(value)) return value;
    // A constant below zero into a u8 / u16 is left for the width check to name.
    if (value.kind === "const") return keepConstant ? value : { kind: "const", value: 0 };
    return { kind: "intrinsic", name: "max", args: [value, { kind: "const", value: 0 }], at, label: "label" in value ? value.label : "" };
  };

  const bool = (e: BoolExpr): BoolExpr => {
    switch (e.kind) {
      case "test": e.expr = num(e.expr)[0]; return e;
      case "compare": {
        const [left, lt] = num(e.left);
        const [right, rt] = num(e.right);
        e.left = left;
        e.right = right;
        const leftU = lt === "u32" || (lt === "flex" && rt === "u32");
        const rightU = rt === "u32" || (rt === "flex" && lt === "u32");
        if (leftU && rightU) e.unsigned = true;
        else if (leftU) e.unsigned = nonNegative(right) ? true : "left";
        else if (rightU) e.unsigned = nonNegative(left) ? true : "right";
        else if (nonNegative(left) && nonNegative(right)) e.unsigned = true;
        return e;
      }
      case "and": case "or": e.items = e.items.map(bool); return e;
      case "not": e.expr = bool(e.expr); return e;
      case "edge": e.cond = bool(e.cond); return e;
      case "ternary": e.cond = bool(e.cond); e.whenTrue = bool(e.whenTrue); e.whenFalse = bool(e.whenFalse); return e;
      case "unitAlive": case "unitFlag": unit(e.unit); return e;
      case "unitSame": unit(e.left); unit(e.right); return e;
      case "call": call(e.call); return e;
      default: return e;
    }
  };

  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); };

  /** A value stored into a variable: a `u8` / `u16` takes nothing below zero, anything else keeps the 32 bits as they are. */
  const stored = (decl: VarDecl | undefined, value: NumExpr, at: At): NumExpr => {
    if (decl?.bits) return floor(value, at, true);
    const [out, t] = num(value);
    // A constant that the variable's type cannot hold would read as another number altogether: better said than stored.
    if (decl && out.kind === "const" && value.kind === "const") {
      if (!decl.unsigned && t === "u32") errors.push({ at, message: `${decl.name} is a number, which holds −2 147 483 648 … 2 147 483 647, not ${out.value}. Declare it a u32 (let ${decl.name}: u32 = …), or write i32(${out.value}) for the signed number with those bits.` });
      if (decl.unsigned && out.value < 0) errors.push({ at, message: `${decl.name} is a u32, which holds 0 … 4 294 967 295, not ${out.value}. Write u32(${out.value}) for the u32 with those bits.` });
    }
    if (!settled && decl && !decl.unsigned) stores.push([decl.id, out]);
    return out;
  };

  /** An initial value or a returned one, whose kind is its variable's (`{ kind: "var" }` alone does not say). */
  const valueFor = <E extends NumExpr | BoolExpr | UnitExpr>(decl: VarDecl, value: E, at: At): E => {
    if (decl.kind === "number") return stored(decl, value as NumExpr, at) as E;
    if (decl.kind === "boolean") return bool(value as BoolExpr) as E;
    unit(value as UnitExpr);
    return value;
  };

  let result: VarDecl | undefined;
  const call = (c: Call) => {
    for (const p of c.params) p.init = valueFor(p.decl, p.init, c.at);
    const saved = result;
    result = c.result?.decl;
    c.body.forEach(stmt);
    result = saved;
  };

  const stmt = (s: Stmt) => {
    switch (s.kind) {
      case "declare": if (!s.failed) s.init = valueFor(s.decl, s.init, s.at); break;
      case "assign": s.value = stored(decls.get(s.target), s.value, s.at); break;
      case "assignBool": s.value = bool(s.value); break;
      case "assignUnit": unit(s.value); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite":
        unit(s.unit);
        s.value = FLAGS.has(s.field) ? bool(s.value as BoolExpr) : floor(s.value as NumExpr, s.at);
        break;
      case "unitDo":
        unit(s.unit);
        if (s.verb.do === "damage" || s.verb.do === "heal") s.verb.amount = floor(s.verb.amount, s.at);
        break;
      case "tableWrite":
        if (s.value.kind !== "text") s.value = s.boolean ? bool(s.value as BoolExpr) : floor(s.value as NumExpr, s.at);
        break;
      case "if": s.cond = bool(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) s.cond = bool(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); s.cond = bool(s.cond); break;
      case "for": if (s.cond) s.cond = bool(s.cond); s.update.forEach(stmt); s.body.forEach(stmt); break;
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "switch": s.value = num(s.value)[0]; s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value && result) s.value = valueFor(result, s.value, s.at); break;
      case "action": for (const v of s.variables ?? []) v.expr = floor(v.expr, s.at); break;
      case "centerLocation": s.x = floor(s.x, s.at); s.y = floor(s.y, s.at); break;
      case "print":
        for (const p of s.parts) {
          if (p.kind !== "number") continue;
          const [value, t] = num(p.expr);
          p.expr = value;
          if (t === "u32") p.unsigned = true;
        }
        break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      default: break;
    }
  };

  // Once to see every store — marking an operation is harmless to repeat, and the casts are kept until the second time — then for good.
  program.body.forEach(stmt);
  for (const [id] of stores) never.add(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, value] of stores) if (never.has(id) && !nonNegative(value)) { never.delete(id); changed = true; }
  }
  settled = true;
  errors.length = 0;
  program.body.forEach(stmt);
  return errors;
}
