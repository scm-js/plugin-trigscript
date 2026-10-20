/**
 * The ledger (`ledger/`): a script for each feature of TrigScript, each with the step of the plan's way off eudplib
 * that makes it a map of our own's, and whether a map of our own takes it today (docs/v4-plan.md, "The way off
 * eudplib, audited"). Its first line says so:
 *
 *   // ledger: step 4, refused: a product of two values
 *   // ledger: step 1, takes
 *
 * then a line or more of what the feature is. `tests/ledger.test.ts` holds every script to its line, and holds the
 * ledger to the language: every kind of the IR, every name a script has from the library and every export of the
 * standard library's modules is in some script, or the test says which is not. `scripts/ledger.mts` prints it by
 * step, and writes the lines anew after a step changes what a map of our own takes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { generateDeclarations } from "../compiler/declarations";
import { defaultScriptNames } from "../compiler/names";
import { STDLIB } from "../compiler/stdlib";
import { emitOwn } from "../compiler/backend/own";
import { defaultLib } from "../bundle/lib.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export const LEDGER_DIR = join(ROOT, "ledger");

export interface Row {
  /** Its path under `ledger/`. */
  file: string;
  step: number;
  /** What its first line says: taken, or refused with these words in the reason. */
  takes: boolean;
  reason?: string;
  what: string;
  source: string;
}

const HEADER = /^\/\/ ledger: step (\d+), (?:(takes)|refused: (.+))$/;

/** A script of the ledger, or what is wrong with its first lines. */
export function parseRow(file: string, source: string): Row | string {
  const lines = source.split("\n");
  const m = HEADER.exec(lines[0].trim());
  if (!m) return `${file}: the first line is not "// ledger: step N, takes" or "// ledger: step N, refused: <reason>"`;
  const what: string[] = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith("//")) break;
    what.push(l.replace(/^\/\/\s?/, ""));
  }
  if (!what.length) return `${file}: no line under the first says what the feature is`;
  return { file, step: Number(m[1]), takes: m[2] === "takes", reason: m[3]?.trim(), what: what.join(" "), source };
}

export function readLedger(dir = LEDGER_DIR): Row[] {
  const out: Row[] = [];
  const errors: string[] = [];
  const visit = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) visit(p);
      else if (/\.tsx?$/.test(f)) {
        const r = parseRow(relative(dir, p).split("\\").join("/"), readFileSync(p, "utf8"));
        if (typeof r === "string") errors.push(r);
        else out.push(r);
      }
    }
  };
  visit(dir);
  if (errors.length) throw new Error(errors.join("\n"));
  return out;
}

let lib: string | undefined;
let names: ReturnType<typeof defaultScriptNames> | undefined;

export interface Outcome {
  /** The compiler's first error, when there is one: a script of the ledger must compile. */
  error?: string;
  takes: boolean;
  /** Why a map of our own refuses it (`emitOwn`). */
  reason?: string;
  /** The IR the script compiled to: its programs. */
  ir: unknown[];
}

/** What a map of our own makes of a script: compiled as the editor compiles it, then `emitOwn`, as `build-own` does. */
export function outcome(row: Pick<Row, "file" | "source">): Outcome {
  lib ??= defaultLib();
  names ??= defaultScriptNames();
  const r = compileScript(ts, { [row.file.endsWith(".tsx") ? "main.tsx" : "main.ts"]: row.source }, names, { lib, emitter: false });
  if (r.diagnostics.length) {
    const d = r.diagnostics[0];
    return { error: `line ${d.line}: ${d.message}`, takes: false, ir: r.ir };
  }
  const own = emitOwn(r);
  return typeof own === "string" ? { takes: false, reason: own, ir: r.ir } : { takes: true, ir: r.ir };
}

/** Whether a row's first line says what the outcome is. */
export function agrees(row: Row, o: Outcome): boolean {
  if (o.error) return false;
  return row.takes ? o.takes : !o.takes && !!o.reason && o.reason.includes(row.reason!);
}

/** The first line a row should have, from its outcome (the refusal's words without its line number). */
export function headerFor(step: number, o: Outcome): string {
  return o.takes ? `// ledger: step ${step}, takes` : `// ledger: step ${step}, refused: ${(o.reason ?? "").replace(/, line \d+$/, "")}`;
}

// ── What the ledger must hold ──

/**
 * Every kind of the IR, from `compiler/ir.ts` itself: the kinds of statements, values, tests, texts, units and the
 * parts of a printed text; each operator; each function of `Math` the IR names; each source of a read. And each source
 * of input, from `compiler/input.ts`. A key is how `irKeys` names what it finds in a program.
 */
export function irKinds(): string[] {
  const ir = readFileSync(join(ROOT, "compiler", "ir.ts"), "utf8");
  const union = (name: string): string => {
    const start = ir.indexOf(`export type ${name} =`);
    if (start < 0) throw new Error(`no ${name} in compiler/ir.ts`);
    return ir.slice(start, ir.indexOf(";\n", ir.indexOf("\n", start)) + 1);
  };
  const keys = new Set<string>();
  for (const u of ["Stmt", "NumExpr", "BoolExpr", "TextExpr", "UnitExpr", "TextPart"]) {
    for (const m of union(u).matchAll(/kind: "(\w+)"/g)) keys.add(m[1]);
  }
  for (const m of union("ArithOp").matchAll(/"([^"]+)"/g)) keys.add(`binary ${m[1]}`);
  const intrinsic = /kind: "intrinsic"; name: ([^;]+);/.exec(union("NumExpr"));
  for (const m of intrinsic![1].matchAll(/"(\w+)"/g)) keys.add(`intrinsic ${m[1]}`);
  for (const m of union("ReadSource").matchAll(/source: "(\w+)"/g)) keys.add(`read ${m[1]}`);
  const input = readFileSync(join(ROOT, "compiler", "input.ts"), "utf8");
  const sources = input.slice(input.indexOf("export type InputSource ="), input.indexOf(";\n", input.indexOf("export type InputSource =")));
  for (const m of sources.matchAll(/source: "(\w+)"/g)) keys.add(`input ${m[1]}`);
  return [...keys].sort();
}

/** What of `irKinds` a program has in it. */
export function irKeys(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) { x.forEach((y) => irKeys(y, out)); return out; }
  if (!x || typeof x !== "object") return out;
  const o = x as Record<string, unknown>;
  if (typeof o.kind === "string") {
    out.add(o.kind);
    if (o.kind === "binary") out.add(`binary ${o.op as string}`);
    if (o.kind === "intrinsic") out.add(`intrinsic ${o.name as string}`);
    if (o.kind === "read") out.add(`read ${(o.read as { source: string }).source}`);
    if (o.kind === "input") out.add(`input ${(o.input as { source: string }).source}`);
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") irKeys(v, out);
  return out;
}

/** The objects whose members are features of their own (`on.killed`, `ui.lines`, `memory.vision`, `local.mouse`). */
const MEMBERS_OF = new Set(["on", "ui", "memory", "local"]);
/** The kinds of value a program holds whose members are features (`u.hp`, `set.forEach`, `task.cancel`). */
const VALUE_TYPES = new Set(["Unit", "UnitSet", "Task"]);

export interface ApiName {
  /** As the ledger lists it: `createUnit`, `on.killed`, `Unit.hp`, `trigscript/fog.reveal`. */
  name: string;
  /** A use of it in a script, its comments and strings taken out. */
  used: RegExp;
  /** The module a script imports it from, for the standard library's, and its name there. */
  module?: string;
  export?: string;
}

const word = (s: string) => s.replace(/[$]/g, "\\$");
/** A name used as itself: not the field of something else (`band.loop` is not `loop`). */
const bare = (n: string) => new RegExp(`(?<![.\\w$])${word(n)}\\b`);

/**
 * Every name a script has from the library: the globals the declarations give a script (but the compiler's own, `__…`,
 * and the JSX namespace), the members of `on`, `ui`, `memory` and `local`, the fields and methods of a unit, a set of
 * units and a task, and what each module of the standard library exports.
 */
export function apiNames(): ApiName[] {
  const out: ApiName[] = [];
  const text = generateDeclarations();
  const sf = ts.createSourceFile("trigscript.d.ts", text, ts.ScriptTarget.ES2022, true);
  const memberNames = (members: ts.NodeArray<ts.TypeElement | ts.ClassElement | ts.Statement>): string[] => {
    const found = new Set<string>();
    for (const m of members) {
      if ((ts.isPropertySignature(m) || ts.isMethodSignature(m) || ts.isGetAccessor(m)) && m.name && ts.isIdentifier(m.name)) found.add(m.name.text);
      if (ts.isVariableStatement(m)) for (const d of m.declarationList.declarations) if (ts.isIdentifier(d.name)) found.add(d.name.text);
      if (ts.isFunctionDeclaration(m) && m.name) found.add(m.name.text);
    }
    return [...found];
  };
  const seen = new Set<string>();
  const add = (n: ApiName) => { if (!seen.has(n.name)) { seen.add(n.name); out.push(n); } };
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) add({ name: st.name.text, used: bare(st.name.text) });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const n = d.name.text;
        add({ name: n, used: bare(n) });
        if (MEMBERS_OF.has(n) && d.type && ts.isTypeLiteralNode(d.type)) {
          for (const m of memberNames(d.type.members)) add({ name: `${n}.${m}`, used: new RegExp(`\\b${word(n)}\\s*\\.\\s*${word(m)}\\b`) });
        }
      }
    }
    if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) {
      const n = st.name.text;
      if (n === "JSX") continue;
      add({ name: n, used: bare(n) });
      if (MEMBERS_OF.has(n) && st.body && ts.isModuleBlock(st.body)) {
        for (const m of memberNames(st.body.statements)) add({ name: `${n}.${m}`, used: new RegExp(`\\b${word(n)}\\s*\\.\\s*${word(m)}\\b`) });
      }
    }
    if (ts.isInterfaceDeclaration(st) && VALUE_TYPES.has(st.name.text)) {
      for (const m of memberNames(st.members)) add({ name: `${st.name.text}.${m}`, used: new RegExp(`\\.\\s*${word(m)}\\b`) });
    }
  }
  for (const [mod, source] of Object.entries(STDLIB)) {
    const msf = ts.createSourceFile(`${mod}.tsx`, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    for (const st of msf.statements) {
      const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const named: string[] = [];
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) named.push(st.name.text);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) named.push(d.name.text);
      for (const n of named) add({ name: `trigscript/${mod}.${n}`, used: bare(n), module: `trigscript/${mod}`, export: n });
    }
  }
  return out.filter((n) => !n.name.split(".").some((part) => part.startsWith("__")));
}

/** A script with its comments and the insides of its strings taken out (a template's `${…}` kept), for `ApiName.used`. */
export function code(source: string): string {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const blank: [number, number][] = [];
  const comments = (pos: number) => {
    for (const c of [...(ts.getLeadingCommentRanges(source, pos) ?? []), ...(ts.getTrailingCommentRanges(source, pos) ?? [])]) blank.push([c.pos, c.end]);
  };
  const visit = (n: ts.Node) => {
    comments(n.getFullStart());
    comments(n.getEnd());
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) blank.push([n.getStart() + 1, n.getEnd() - 1]);
    // (A template's text between its `${…}`: from after the backtick or `}` to before the `${` or the closing backtick.)
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n)) blank.push([n.getStart() + 1, n.getEnd() - 2]);
    else if (ts.isTemplateTail(n)) blank.push([n.getStart() + 1, n.getEnd() - 1]);
    else if (ts.isJsxText(n)) blank.push([n.getStart(), n.getEnd()]);
    n.forEachChild(visit);
  };
  visit(sf);
  const chars = source.split("");
  for (const [a, b] of blank) for (let i = a; i < b; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

const codes = new Map<string, string>();

/** Whether a script uses a name: in its code, and imported from the module when it is the standard library's. */
export function uses(row: Pick<Row, "source">, name: ApiName): boolean {
  let c = codes.get(row.source);
  if (c === undefined) codes.set(row.source, (c = code(row.source).replace(/^\s*import\b[^;]*;/gm, "")));
  if (!name.module) return name.used.test(c);
  // (The standard library's: imported from its module — by its name, under another, or with the module or an object of
  // it — and used so.)
  for (const m of row.source.matchAll(/import\s*(?:\*\s*as\s+(\w+)|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g)) {
    if (m[3] !== name.module) continue;
    if (m[1] && new RegExp(`\\b${m[1]}\\s*\\.\\s*${word(name.export!)}\\b`).test(c)) return true;
    for (const spec of (m[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/).map((x) => x.trim());
      if (orig === name.export && bare(local).test(c)) return true;
      if (new RegExp(`(?<![.\\w$])${word(local)}\\s*\\.\\s*${word(name.export!)}\\b`).test(c)) return true;
    }
  }
  return false;
}
