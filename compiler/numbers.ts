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
 *
 * And the fourth, `fixed` (TrigScript 4, B6): a number with a fraction, 16.16 — its cell is the value times 65 536,
 * so 1.5 is 98 304 — from −32 768 to 32 767.99998. A fraction in a constant (`0.5`, `Math.PI`), a `fixed`
 * annotation, `fixed(x)`, `Math.sqrt` / `sin` / `cos` / `tan` / `atan2` / `hypot` make one; so does arithmetic with
 * one in it. Nothing else changes for a program that has none.
 *
 * - **A variable is fixed when anything stored into it is**, as JavaScript's numbers would hold the fraction: `let x =
 *   0; x += 0.5` makes `x` fixed everywhere. That is found as the never-below-zero ones are, by going over the program
 *   until no variable changes; a `u8` / `u16` / `u32` stays whole and storing a fraction into one is an error.
 * - **Mixing converts, as TypeScript would compute:** a whole number beside a fixed one is turned into one (`<< 16`,
 *   or the constant times 65 536), except where it need not be — a fixed times a whole number, and a fixed divided by
 *   one, are the raw cell's own `*` and `/`. A product or a quotient of two fixed numbers is `fmul` / `fdiv`.
 * - **Where only a whole number makes sense** — an index, a count, a place on the map, a unit's field, a shift, a
 *   bitwise operator — a fixed one is an error that names `Math.floor` / `round` / `trunc`; `x | 0` is `Math.trunc`.
 * - **Rounding** (`floor`, `ceil`, `round`, `trunc`, which the front end gives for every `Math.` one) is turned into
 *   shifts and a division here, and is nothing at all of a whole number. `sin` / `cos` read a table of 4 096 cells this
 *   pass adds to the program (`__sin`), and `atan2` one of 1 025 (`__atan`), both between their cells, so that both
 *   backends read the same values and are as close as a fixed number can be.
 */
import { I32_MAX, UNIT_FLAGS, isTextExpr, mapText, mapTextOperands, programDeclarations, type At, type BoolExpr, type Call, type NumExpr, type Program, type Stmt, type TextExpr, type TextMap, type TextPart, type UnitExpr, type VarDecl } from "./ir";
import type { ProgramDiagnostic } from "./eud";

/** `flex`: a constant from 0 to 2 147 483 647, which is the same whichever way it is read. `fixed`: a 16.16 number. */
type NumType = "i32" | "u32" | "flex" | "fixed";

/** One, as a fixed number's cell. */
export const FIXED_ONE = 65536;
/** The fixed numbers' ends, as values. */
export const FIXED_MIN = -32768;
export const FIXED_MAX = 32767.99998474121;
/** The sine table's size, a whole turn: `sin(x)` reads cell round(x × 4 096 / 2π) mod 4 096. */
export const SIN_STEPS = 4096;
/** x × this (a fixed number) is x's place in the sine table, in its steps. */
export const SIN_SCALE = fixedRaw(SIN_STEPS / (2 * Math.PI));
/** The arc tangent table's: atan(i / 1 024) for i from 0 to 1 024. */
export const ATAN_STEPS = 1024;

/** A value as a fixed number's raw cell, rounded to the nearest; what a constant with a fraction is in the IR. */
export function fixedRaw(value: number): number {
  return Math.round(value * FIXED_ONE) | 0;
}

/** The cells of the sine table: sin(2π i / 4 096) as fixed numbers. */
export function sinTable(): number[] {
  return Array.from({ length: SIN_STEPS }, (_, i) => fixedRaw(Math.sin((2 * Math.PI * i) / SIN_STEPS)));
}

/** The cells of the arc tangent table: atan(i / 1 024) as fixed numbers. */
export function atanTable(): number[] {
  return Array.from({ length: ATAN_STEPS + 1 }, (_, i) => fixedRaw(Math.atan(i / ATAN_STEPS)));
}

const FLAGS: ReadonlySet<string> = new Set(UNIT_FLAGS);

export function typeNumbers(program: Program): ProgramDiagnostic[] {
  const errors: ProgramDiagnostic[] = [];
  /** The signed variables nothing ever puts below zero, and every store the program makes, from which they are found. */
  const never = new Set<string>();
  const stores: [string, NumExpr][] = [];
  /**
   * Loop counters (cheaper lowering): `for (…; i < e; i++)` adds 1 to `i` only after `i < e` held with that same `i`, so
   * from a start that is never below zero it never reaches past 2 147 483 647. The update's stored value, so that the
   * search below takes it as never below zero while `i` is; the counters of the loops being walked; and the counters
   * that cannot be trusted that way — stored into inside their loop, or by a function, which could put them anywhere.
   */
  const counted = new WeakSet<NumExpr>();
  let counter: string | null = null;
  const counting: string[] = [];
  const spoiled = new Set<string>();
  let inFunction = false;
  let settled = false;
  /** Whether a pass found another variable or array fixed: the passes before the last go on until one finds none. */
  let grew = false;
  /** Where each variable or array found fixed was first stored a fraction: what an error about it as a whole number points at. */
  const madeFixed = new Map<string, At>();
  const decls = new Map<string, VarDecl>(programDeclarations(program).map((d) => [d.id, d]));
  const functions = new Map((program.functions ?? []).map((f) => [f.id, f]));
  /** An array is typed as a variable is, and found never below zero the same way: by everything ever stored into a cell of it. */
  const arrays = new Map(program.arrays.map((a) => [a.id, a]));
  for (const a of program.arrays) if (a.values && !a.unsigned && a.values.every((v) => v >= 0)) never.add(a.id);
  const mixed = (at: At, what: string) => errors.push({ at, message: `${what} mixes a number, which is signed, with a u32. Say which is meant: u32(x) reads a number's 32 bits from 0 up, i32(x) a u32's as a signed number.` });
  const mixedFixed = (at: At, what: string) => errors.push({ at, message: `${what} mixes a fixed number, one with a fraction, with a u32. Say which is meant: i32(x) reads the u32 as a signed whole number, which mixes with a fixed one.` });
  const labelOf = (e: NumExpr): string => ("label" in e ? e.label : "");
  /** Why a variable is fixed, when a pass found it so: said beside an error about it as a whole number. */
  const whyFixed = (e: NumExpr): string => {
    const id = e.kind === "var" ? e.id : e.kind === "element" || e.kind === "pop" ? e.array : undefined;
    const at = id === undefined ? undefined : madeFixed.get(id);
    const name = id === undefined ? undefined : (decls.get(id) ?? arrays.get(id))?.name;
    return at && name ? ` (${name} is fixed: line ${at.line} stores a fraction into it)` : "";
  };
  const fraction = (at: At, what: string, e: NumExpr) => errors.push({ at, message: `${what} is a fixed number, one with a fraction${whyFixed(e)}, and only a whole number goes here: say how to round it — Math.floor(x), Math.round(x) or Math.trunc(x).` });

  /** The type two sides of one operation share; an error when one is signed and the other a `u32`. A fixed side makes it fixed. */
  const unify = (a: NumType, b: NumType, at: At, what: string): NumType => {
    if (a === "fixed" || b === "fixed") {
      if (a === "u32" || b === "u32") mixedFixed(at, what);
      return "fixed";
    }
    if (a === "flex") return b;
    if (b === "flex" || a === b) return a;
    mixed(at, what);
    return "i32";
  };

  /** A value as a fixed number, on the pass that is for good: a whole one shifted up 16 bits (a constant times 65 536). */
  const asFixed = (e: NumExpr, t: NumType, at: At): NumExpr => {
    if (!settled || t === "fixed") return e;
    if (e.kind === "const") {
      if (e.value < FIXED_MIN || e.value > Math.floor(FIXED_MAX)) {
        errors.push({ at, message: `${e.value} is reckoned with a fixed number here, and a fixed number holds −32 768 … 32 767.99998. Keep the whole numbers apart, or scale them down first.` });
        return { kind: "const", value: 0, fixed: true };
      }
      return { kind: "const", value: (e.value * FIXED_ONE) | 0, fixed: true };
    }
    return { kind: "binary", op: "<<", left: e, right: { kind: "const", value: 16 }, at, label: labelOf(e) };
  };
  const fixedOp = (name: "fmul" | "fdiv", a: NumExpr, b: NumExpr, at: At, label: string): NumExpr => ({ kind: "intrinsic", name, args: [a, b], at, label });

  /** A fixed number rounded to a whole one: shifts for floor, ceil and round, a division towards zero for trunc. */
  const rounded = (how: "floor" | "ceil" | "round" | "trunc", x: NumExpr, at: At, label: string): NumExpr => {
    const k = (value: number): NumExpr => ({ kind: "const", value });
    if (how === "trunc") return { kind: "binary", op: "/", left: x, right: k(FIXED_ONE), at, label };
    const shifted = how === "floor" ? x : { kind: "binary", op: "+", left: x, right: k(how === "ceil" ? FIXED_ONE - 1 : FIXED_ONE / 2), at, label } as NumExpr;
    return { kind: "binary", op: ">>", left: shifted, right: k(16), at, label };
  };

  /** A table this pass adds to the program, once: the same cells for the game and the simulator. */
  const table = (id: string, name: string, values: () => number[]): string => {
    if (!arrays.has(id)) {
      const v = values();
      const a = { id, name, kind: "number" as const, length: v.length, shared: true, fixed: true, values: v, at: program.at };
      program.arrays.push(a);
      arrays.set(id, a);
    }
    return id;
  };

  /** sin(x) / cos(x) of a fixed number of radians: the sine table read between its cells, x × 4 096 / 2π the place (the scale is the second argument). */
  const sine = (cos: boolean, x: NumExpr, at: At, label: string): NumExpr =>
    ({ kind: "intrinsic", name: cos ? "cos" : "sin", args: [x, { kind: "const", value: SIN_SCALE, fixed: true }], table: table("__sin", "Math.sin's table", sinTable), at, label });

  const arrayType = (id: string): NumType => { const a = arrays.get(id); return a?.fixed ? "fixed" : a?.unsigned ? "u32" : "i32"; };

  /** Whether a signed value can be seen never to be below zero. */
  const nonNegative = (e: NumExpr): boolean => {
    switch (e.kind) {
      case "const": return e.value >= 0 && e.value <= I32_MAX;
      case "var": return !!decls.get(e.id)?.bits || never.has(e.id);
      case "element": case "pop": return !!arrays.get(e.array)?.bits || never.has(e.array);
      case "length": case "textLength": case "taskHandle": return true;
      case "read": case "unitField": case "tableRead": case "input": case "randomInt": return true;
      case "ternary": return nonNegative(e.whenTrue) && nonNegative(e.whenFalse);
      case "intrinsic": return e.unsigned ? false : e.name === "min" ? e.args.every(nonNegative) : e.name === "max" ? e.args.some(nonNegative) : e.name === "sqrt";
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

  /** A number where only a whole one makes sense: an index, a switch's value, a task. */
  const whole = (e: NumExpr, at: At, what = "This"): NumExpr => {
    const [value, t] = num(e);
    if (t === "fixed") fraction(at, what, value);
    return value;
  };

  /** The expression with its operations marked and its casts removed, and what it is read as. */
  const num = (e: NumExpr): [NumExpr, NumType] => {
    switch (e.kind) {
      case "const": return [e, e.fixed ? "fixed" : e.value < 0 ? "i32" : e.value > I32_MAX ? "u32" : "flex"];
      case "var": { const d = decls.get(e.id); return [e, d?.fixed ? "fixed" : d?.unsigned ? "u32" : "i32"]; }
      case "element": e.index = whole(e.index, e.at, "An index"); return [e, arrayType(e.array)];
      case "pop": return [e, arrayType(e.array)];
      // The length of an array that does not grow is a constant. Only on the pass that is for good: by then the front end has met every push.
      case "length": { const a = arrays.get(e.array); return settled && a && !a.dynamic ? [{ kind: "const", value: a.length }, "flex"] : [e, "i32"]; }
      case "cast": {
        // Gone only on the pass that is for good: the first one still has to find it here the second time.
        const [inner, t] = num(e.expr);
        if (e.to === "fixed") {
          if (t === "u32") mixedFixed(e.at, "fixed(…) of a u32");
          if (settled) return [asFixed(inner, t, e.at), "fixed"];
          e.expr = inner;
          return [e, "fixed"];
        }
        if (t === "fixed") fraction(e.at, `${e.to}(…) reads a whole number's 32 bits; what it is given`, inner);
        if (settled) return [inner, e.to];
        e.expr = inner;
        return [e, e.to];
      }
      case "unary": {
        const [inner, t] = num(e.expr);
        e.expr = inner;
        return [e, t === "u32" ? "u32" : t === "fixed" ? "fixed" : "i32"];
      }
      case "binary": {
        const [left, lt] = num(e.left);
        const [right, rt] = num(e.right);
        e.left = left;
        e.right = right;
        const fixedSide = lt === "fixed" || rt === "fixed";
        if (e.op === "<<" || e.op === ">>" || e.op === ">>>") {
          if (fixedSide) { fraction(e.at, lt === "fixed" ? "What this shifts" : "This shift's count", lt === "fixed" ? left : right); return [e, "i32"]; }
          // What is shifted decides; the count is a count. `x >>> 0` is JavaScript's own way of writing u32(x).
          if (e.op === ">>>" && right.kind === "const" && right.value === 0) return [settled ? left : e, "u32"];
          if (e.op === ">>" && lt === "u32") e.op = ">>>";
          return [e, lt === "flex" ? "i32" : lt];
        }
        if (fixedSide && (e.op === "&" || e.op === "|" || e.op === "^")) {
          // `x | 0`, JavaScript's way of dropping the fraction: Math.trunc(x).
          if (e.op === "|" && lt === "fixed" && right.kind === "const" && right.value === 0 && !right.fixed) return [settled ? rounded("trunc", left, e.at, e.label) : e, "i32"];
          fraction(e.at, `What ${e.op} is given`, lt === "fixed" ? left : right);
          return [e, "i32"];
        }
        if (fixedSide) {
          if (lt === "u32" || rt === "u32") mixedFixed(e.at, `This ${e.op === "+" ? "sum" : e.op === "-" ? "difference" : e.op === "*" ? "product" : "division"}`);
          // A fixed number times (or divided by) a whole one is the raw cell's own product (or quotient): nothing to convert.
          if (e.op === "*") return [lt === "fixed" && rt === "fixed" && settled ? fixedOp("fmul", left, right, e.at, e.label) : e, "fixed"];
          if (e.op === "/") return [rt === "fixed" && settled ? fixedOp("fdiv", asFixed(left, lt, e.at), right, e.at, e.label) : e, "fixed"];
          e.left = asFixed(left, lt, e.at);
          e.right = asFixed(right, rt, e.at);
          return [e, "fixed"];
        }
        const t = unify(lt, rt, e.at, `This ${e.op === "+" ? "sum" : e.op === "-" ? "difference" : e.op === "*" ? "product" : e.op === "/" || e.op === "%" ? "division" : "operation"}`);
        if ((e.op === "/" || e.op === "%") && t === "u32") e.unsigned = true;
        return [e, t === "flex" ? "i32" : t];
      }
      case "randomInt": e.bound = floor(e.bound, e.at); return [e, "i32"];
      case "taskHandle": return [e, "i32"];
      case "unitField": unit(e.unit); return [e, "i32"];
      // A part of a unit is bits to keep, never a number to reckon with: read from 0 up, so nothing clamps or biases it.
      case "unitPart": unit(e.unit); return [e, "u32"];
      case "ternary": {
        e.cond = bool(e.cond);
        const [a, at] = num(e.whenTrue);
        const [b, bt] = num(e.whenFalse);
        const t = unify(at, bt, e.at, "This ? :");
        e.whenTrue = t === "fixed" ? asFixed(a, at, e.at) : a;
        e.whenFalse = t === "fixed" ? asFixed(b, bt, e.at) : b;
        return [e, t];
      }
      case "intrinsic": {
        const typed = e.args.map(num);
        e.args = typed.map(([a]) => a);
        const types = typed.map(([, t]) => t);
        switch (e.name) {
          case "abs":
            // A u32 is never below zero: it is its own distance from 0.
            if (types[0] === "u32") return [e.args[0], "u32"];
            return [e, types[0] === "fixed" ? "fixed" : "i32"];
          case "floor": case "ceil": case "round": case "trunc":
            // Of a whole number, nothing to do.
            if (types[0] !== "fixed") return [settled ? e.args[0] : e, types[0]];
            return [settled ? rounded(e.name, e.args[0], e.at, e.label) : e, "i32"];
          case "fmul": case "fdiv": return [e, "fixed"];
          case "sqrt":
            // Of a whole number, the root of it read from 0 up (so that Math.hypot of distances in pixels does not overflow a fixed square).
            if (types[0] !== "fixed") { if (settled) e.unsigned = true; return [e, "fixed"]; }
            return [e, "fixed"];
          case "atan2": case "sin": case "cos":
            if (types.includes("u32")) mixedFixed(e.at, `Math.${e.name}()`);
            if (!settled) return [e, "fixed"];
            e.args = e.args.map((a, i) => asFixed(a, types[i], e.at));
            if (e.name === "sin" || e.name === "cos") return [sine(e.name === "cos", e.args[0], e.at, e.label), "fixed"];
            if (e.name === "atan2") e.table = table("__atan", "Math.atan2's table", atanTable);
            return [e, "fixed"];
        }
        const t = types.reduce((a, b) => unify(a, b, e.at, `Math.${e.name}()`));
        if (t === "fixed") { e.args = e.args.map((a, i) => asFixed(a, types[i], e.at)); return [e, "fixed"]; }
        if (t === "u32") e.unsigned = true;
        return [e, t === "flex" ? "i32" : t];
      }
      case "call": call(e.call); { const d = e.call.result?.decl; return [e, d?.fixed ? "fixed" : d?.unsigned ? "u32" : "i32"]; }
      case "textLength": case "textIndexOf": case "textCode": return [Object.assign(e, mapTextOperands(e, texts)), "i32"];
      default: return [e, "i32"];
    }
  };

  /** A number going where the game takes none below zero: `max(v, 0)` unless it is a `u32` or seen never to be below. A fixed one is an error: the game's numbers there are whole. */
  const floor = (e: NumExpr, at: At, keepConstant = false): NumExpr => {
    const [value, t] = num(e);
    if (t === "fixed") { fraction(at, "This", value); return value; }
    if (!settled || t === "u32" || nonNegative(value)) return value;
    // A constant below zero into a u8 / u16 is left for the width check to name.
    if (value.kind === "const") return keepConstant ? value : { kind: "const", value: 0 };
    return { kind: "intrinsic", name: "max", args: [value, { kind: "const", value: 0 }], at, label: "label" in value ? value.label : "" };
  };

  const bool = (e: BoolExpr): BoolExpr => {
    switch (e.kind) {
      case "test": e.expr = num(e.expr)[0]; return e;
      case "element": e.index = whole(e.index, e.at, "An index"); return e;
      case "compare": {
        const [left, lt] = num(e.left);
        const [right, rt] = num(e.right);
        if (lt === "fixed" || rt === "fixed") {
          // Both as fixed numbers, compared as the signed cells they are.
          if (lt === "u32" || rt === "u32") mixedFixed(e.at, "This comparison");
          e.left = asFixed(left, lt, e.at);
          e.right = asFixed(right, rt, e.at);
          if (nonNegative(e.left) && nonNegative(e.right)) e.unsigned = true;
          return e;
        }
        e.left = left;
        e.right = right;
        const leftU = lt === "u32" || (lt === "flex" && rt === "u32");
        const rightU = rt === "u32" || (rt === "flex" && lt === "u32");
        if (leftU && rightU) e.unsigned = true;
        else if (leftU) e.unsigned = nonNegative(right) ? true : "left";
        else if (rightU) e.unsigned = nonNegative(left) ? true : "right";
        else if (nonNegative(left) && nonNegative(right)) e.unsigned = true;
        // One side never below zero reads the same from 0 up: marked so, the lowering compares without an addition a side
        // (a loop's `i < n`). Not for a constant beside a signed value, which has a cheaper way of its own.
        else if (nonNegative(left) && right.kind !== "const" && left.kind !== "const") e.unsigned = "left";
        else if (nonNegative(right) && left.kind !== "const" && right.kind !== "const") e.unsigned = "right";
        return e;
      }
      case "and": case "or": e.items = e.items.map(bool); return e;
      case "not": e.expr = bool(e.expr); return e;
      case "edge": e.cond = bool(e.cond); return e;
      case "running": e.task = whole(e.task, e.at); return e;
      case "ternary": e.cond = bool(e.cond); e.whenTrue = bool(e.whenTrue); e.whenFalse = bool(e.whenFalse); return e;
      case "unitAlive": case "unitFlag": unit(e.unit); return e;
      case "unitSame": unit(e.left); unit(e.right); return e;
      case "textCompare": case "textTest": return Object.assign(e, mapTextOperands(e, texts));
      case "call": call(e.call); return e;
      default: return e;
    }
  };

  /** A text's numbers are typed as any are; one that is shown says which way it is read, as a `print`'s does. */
  const shown = (parts: TextPart[]) => {
    for (const p of parts) {
      if (p.kind === "value") text(p.text);
      if (p.kind === "char") { p.expr = whole(p.expr, { file: "", line: 0, column: 0 }); continue; }
      if (p.kind !== "number") continue;
      const [value, t] = num(p.expr);
      p.expr = value;
      if (t === "u32") p.unsigned = true;
      if (t === "fixed") p.fixed = true;
    }
  };
  const text = (t: TextExpr): TextExpr => {
    if (t.kind === "template") { shown(t.parts); return t; }
    return Object.assign(t, mapText(t, texts));
  };
  const texts: TextMap = { num: (e) => num(e)[0], bool: (e) => bool(e), call: (c) => { call(c); return c; }, text };

  const unit = (u: UnitExpr) => { if (u.kind === "call") call(u.call); else if (u.kind === "unitAt") { u.ptr = num(u.ptr)[0]; u.epd = num(u.epd)[0]; u.uid = num(u.uid)[0]; } };

  /**
   * A value stored into a variable: a `u8` / `u16` takes nothing below zero, anything else keeps the 32 bits as they are.
   * A fraction stored makes the variable fixed (the passes before the last find which), and a whole number stored into a
   * fixed one is turned into one.
   */
  const stored = (decl: Pick<VarDecl, "id" | "name" | "bits" | "unsigned" | "fixed"> | undefined, value: NumExpr, at: At): NumExpr => {
    if (decl?.bits) return floor(value, at, true);
    const [out, t] = num(value);
    if (decl && t === "fixed" && !decl.fixed) {
      if (decl.unsigned) errors.push({ at, message: `${decl.name} is a u32, which holds whole numbers, and this is a fixed number, one with a fraction. Round it (Math.floor(x), Math.round(x)), or declare ${decl.name} without the u32.` });
      else if (!settled) { decl.fixed = true; grew = true; madeFixed.set(decl.id, at); }
    }
    if (decl?.fixed) {
      if (t === "u32") mixedFixed(at, `Storing a u32 into ${decl.name}, a fixed number,`);
      return asFixed(out, t, at);
    }
    // A constant that the variable's type cannot hold would read as another number altogether: better said than stored.
    if (decl && out.kind === "const" && value.kind === "const") {
      if (!decl.unsigned && t === "u32") errors.push({ at, message: `${decl.name} is a number, which holds −2 147 483 648 … 2 147 483 647, not ${out.value}. Declare it a u32 (let ${decl.name}: u32 = …), or write i32(${out.value}) for the signed number with those bits.` });
      if (decl.unsigned && out.value < 0) errors.push({ at, message: `${decl.name} is a u32, which holds 0 … 4 294 967 295, not ${out.value}. Write u32(${out.value}) for the u32 with those bits.` });
    }
    if (!settled && decl && !decl.unsigned) {
      if (counter === decl.id && isIncrement(value, decl.id)) counted.add(out);
      else if (inFunction || counting.includes(decl.id)) spoiled.add(decl.id);
      stores.push([decl.id, out]);
    }
    return out;
  };

  /** An initial value or a returned one, whose kind is its variable's (`{ kind: "var" }` alone does not say). */
  const valueFor = <E extends NumExpr | BoolExpr | UnitExpr | TextExpr>(decl: VarDecl, value: E, at: At): E => {
    if (isTextExpr(value)) return text(value) as E;
    if (decl.kind === "number") return stored(decl, value as NumExpr, at) as E;
    if (decl.kind === "boolean") return bool(value as BoolExpr) as E;
    unit(value as UnitExpr);
    return value;
  };

  let result: VarDecl | undefined;
  const call = (c: Call) => {
    // A called function's parameter is stored into by every call of it, and what it returned is copied into the call's own result.
    for (const p of c.params) p.init = valueFor(p.decl, p.init, c.at);
    const returned = c.fn ? functions.get(c.fn)?.result?.decl : undefined;
    if (!settled && returned && c.result?.kind === "number" && !c.result.decl.unsigned) stores.push([c.result.decl.id, { kind: "var", id: returned.id }]);
    // A function that returns a fraction gives its calls' results one too.
    if (!settled && returned?.fixed && c.result?.kind === "number" && !c.result.decl.fixed && !c.result.decl.unsigned && !c.result.decl.bits) { c.result.decl.fixed = true; grew = true; madeFixed.set(c.result.decl.id, c.at); }
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
      case "declareArray": {
        const a = arrays.get(s.array);
        const cell = (v: NumExpr | BoolExpr) => (a?.kind === "boolean" ? bool(v as BoolExpr) : stored(a, v as NumExpr, s.at));
        if (s.init) s.init = s.init.map(cell);
        if (s.fill) s.fill = cell(s.fill);
        break;
      }
      case "push": {
        const a = arrays.get(s.array);
        s.value = a?.kind === "boolean" ? bool(s.value as BoolExpr) : stored(a, s.value as NumExpr, s.at);
        break;
      }
      case "setLength": s.value = floor(s.value, s.at); break;
      case "store": {
        const a = arrays.get(s.array);
        s.index = whole(s.index, s.at, "An index");
        s.value = a?.kind === "boolean" ? bool(s.value as BoolExpr) : stored(a, s.value as NumExpr, s.at);
        break;
      }
      case "assignUnit": unit(s.value); break;
      case "assignText": s.value = text(s.value); break;
      case "storeText": s.index = whole(s.index, s.at, "An index"); s.value = text(s.value); break;
      case "releaseText": s.index = whole(s.index, s.at, "An index"); break;
      case "textLoop": s.of = text(s.of); s.body.forEach(stmt); break;
      case "unitLoop": s.body.forEach(stmt); break;
      case "unitWrite":
        unit(s.unit);
        s.value = FLAGS.has(s.field) ? bool(s.value as BoolExpr) : floor(s.value as NumExpr, s.at);
        break;
      case "select": s.units.forEach(unit); break;
      case "unitDo":
        unit(s.unit);
        if (s.verb.do === "damage" || s.verb.do === "heal") s.verb.amount = floor(s.verb.amount, s.at);
        break;
      case "tableWrite":
        s.value = isTextExpr(s.value) ? text(s.value) : s.boolean ? bool(s.value as BoolExpr) : floor(s.value as NumExpr, s.at);
        break;
      case "if": s.cond = bool(s.cond); s.then.forEach(stmt); s.else?.forEach(stmt); break;
      case "while": if (s.cond) s.cond = bool(s.cond); s.body.forEach(stmt); break;
      case "do": s.body.forEach(stmt); s.cond = bool(s.cond); break;
      case "for": {
        if (s.cond) s.cond = bool(s.cond);
        const i = settled ? null : counterOf(s);
        counter = i;
        s.update.forEach(stmt);
        counter = null;
        if (i) counting.push(i);
        s.body.forEach(stmt);
        if (i) counting.pop();
        break;
      }
      case "unrolled": s.iterations.forEach((i) => i.forEach(stmt)); break;
      case "parallel": s.branches.forEach((b) => b.forEach(stmt)); break;
      case "start": call(s.call); break;
      case "cancel": s.task = whole(s.task, s.at); break;
      case "switch": s.value = whole(s.value, s.at, "A switch's value"); s.cases.forEach((c) => c.body.forEach(stmt)); break;
      case "return": if (s.value && result) s.value = valueFor(result, s.value, s.at); break;
      case "action": for (const v of s.variables ?? []) v.expr = floor(v.expr, s.at); if (s.text) s.text = text(s.text); break;
      case "syncSend": s.value = floor(s.value, s.at); break;
      case "centerLocation": s.x = floor(s.x, s.at); s.y = floor(s.y, s.at); if (s.size) s.size = { width: floor(s.size.width, s.at), height: floor(s.size.height, s.at) }; break;
      case "print": case "buildText": shown(s.parts); break;
      case "call": call(s.call); break;
      case "block": s.body.forEach(stmt); break;
      case "try": s.body.forEach(stmt); s.catch.forEach(stmt); break;
      default: break;
    }
  };

  // Over and over until no variable is found fixed that was not — marking an operation is harmless to repeat, and the
  // casts are kept until the last time — to see every store, then for good.
  const everything = () => {
    program.body.forEach(stmt);
    inFunction = true;
    for (const f of program.functions ?? []) { result = f.result?.decl; f.body.forEach(stmt); result = undefined; }
    inFunction = false;
  };
  for (let passes = 0; passes < 64; passes++) {
    grew = false;
    everything();
    if (!grew) break;
  }
  for (const [id] of stores) never.add(id);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, value] of stores) if (never.has(id) && !(counted.has(value) && !spoiled.has(id)) && !nonNegative(value)) { never.delete(id); changed = true; }
  }
  settled = true;
  errors.length = 0;
  everything();
  return errors;
}

/** `i = i + 1` (or `1 + i`) as a stored value. */
function isIncrement(value: NumExpr, id: string): boolean {
  if (value.kind !== "binary" || value.op !== "+") return false;
  const me = (e: NumExpr) => e.kind === "var" && e.id === id, one = (e: NumExpr) => e.kind === "const" && e.value === 1;
  return (me(value.left) && one(value.right)) || (one(value.left) && me(value.right));
}

/** The counter of a `for` whose test is `i < e` (or `e > i`, alone or one of an `&&`) and whose update adds 1 to it; null for any other. */
function counterOf(s: Extract<Stmt, { kind: "for" }>): string | null {
  const tests = !s.cond ? [] : s.cond.kind === "and" ? s.cond.items : [s.cond];
  for (const t of tests) {
    if (t.kind !== "compare" || t.unsigned) continue;
    const id = t.op === "<" && t.left.kind === "var" ? t.left.id : t.op === ">" && t.right.kind === "var" ? t.right.id : null;
    if (id && s.update.some((u) => u.kind === "assign" && u.target === id && isIncrement(u.value, id))) return id;
  }
  return null;
}
