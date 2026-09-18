/**
 * The TrigScript compiler: the script's files are a real TypeScript program, checked
 * against the generated declarations and the standard library, emitted as CommonJS and
 * *run*. Running is what defines the raw level — every `trigger()` the script calls,
 * through whatever helpers and loops it likes, records one trigger — and `program()`
 * bodies are the structured level: the run records where each body is and the values
 * of its build-time parts (`hoist.ts`), and `structured.ts` turns the body into IR
 * (`ir.ts`). The IR is the output for a program: eudplib builds it into the map when the
 * map is saved (`python/trigscript.py`), so a program needs StarCraft: Remastered and
 * costs the map no triggers, death counters or switches of its own.
 *
 * Strings are not interned here (the compiler runs in a worker, away from the map):
 * text/wav fields hold local ids into `strings`, resolved by the build step. The
 * `typescript` namespace is passed in so tests (Node) and the worker share one
 * implementation, and the standard library's text comes in as an option because the
 * worker fetches it and the tests read it from node_modules.
 */
import type * as TS from "typescript";
import type { TriggerRecord } from "../vendor/triggers";
import { MODULE_NAME } from "./api";
import { DECLARATIONS_FILE, generateDeclarations } from "./declarations";
import { libraryCallName, libraryName, planProgram, transformer, type ProgramPlan } from "./hoist";
import { runModules, type LinkedFile } from "./link";
import { checkProgram } from "./eud";
import { declarations, type Program } from "./ir";
import { LowerError, PLAYER_SLOTS } from "./lower";
import type { ScriptNames } from "./names";
import { Collector, createRuntime, type GameFunctionValue, type ProgramDescriptor, type ScriptString } from "./runtime";
import { newBody, Structured, type Body } from "./structured";

export type { ScriptString } from "./runtime";
export { DEATHS_TABLE_ADDRESS } from "./runtime";

/** The file a script starts from. */
export const ENTRY_FILE = "main.ts";
const LIB_FILE = "lib.d.ts";

/** The script's files by path (`main.ts`, `bases.ts`, `ai/waves.ts`). */
export type ScriptFiles = Record<string, string>;

export interface ScriptDiagnostic {
  file: string;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  /** TypeScript's checker, the program compiler, or the script itself throwing when it ran. */
  source: "typescript" | "compiler" | "script";
}

export interface TriggerSource {
  file: string;
  /** 1-based: the `trigger(` call, or the statement of a program the trigger came from. */
  line: number;
}

/** A span of a file, 1-based, the end exclusive. */
export interface SourceRange {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface VariableInfo {
  name: string;
  kind: "number" | "boolean";
  /** Index into `programs` of the program it belongs to. */
  program: number;
  /** One value for every player of a per-player program (`shared(…)`); otherwise a per-player program has one per player. */
  shared: boolean;
  /** Where the variable is declared. */
  at: { file: string; line: number; column: number };
  /** A `u8` (8) or `u16` (16) variable; unset for the full 32 bits. */
  bits?: number;
}

/** Something the compiler has to say about a line that is not a fault: a loop unrolled when the script was built. */
export interface LineHint {
  file: string;
  line: number;
  /** The short form the editor shows at the end of the line ("unrolled ×6"). */
  label: string;
  note: string;
}

export interface ProgramInfo {
  /** `const award = game(…)`: the name, when the program has one. */
  name?: string;
  /** A player slot the program runs as (0-based; the first, when it runs for several) — what a simulation runs it as. */
  owner: number;
  /** The player groups it runs for: slots, or All Players / a force. */
  owners: number[];
  /** Runs for several players at once, every variable per player. */
  perPlayer: boolean;
  /** Where the `program(` call is. */
  source: TriggerSource;
}

/** Where the script names one of the map's things: `locations.Beacon`, `switches["Door"]`, resolved by the checker — through aliases and namespace imports, never in a comment, a string or a shadowing variable. */
export interface MapReference extends SourceRange {
  /** The table (`locations`, `switches`, `units`, `players`, `aiScripts`). */
  object: string;
  key: string;
  /** `locations["Beacon"]`: the range covers the string literal, quotes included. */
  quoted: boolean;
}

export interface CompileResult {
  /** The `trigger()` calls' records, in order — ordinary triggers, written into the map. Programs are not in here: see `ir`. */
  triggers: TriggerRecord[];
  /** Per trigger, where it came from; null for a hyper trigger. */
  sources: (TriggerSource | null)[];
  /** Local string table: a record's `text` / `wav` field `k > 0` means `strings[k - 1]`. */
  strings: ScriptString[];
  diagnostics: ScriptDiagnostic[];
  /** The programs' variables, in declaration order; a function's copies and results are left out. */
  variables: VariableInfo[];
  programs: ProgramInfo[];
  /** Inside the programs, the expressions computed when the script is built rather than in the game — what the editor underlines. */
  buildTime: SourceRange[];
  /** What the compiler did to a line that is worth a word at its end. */
  hints: LineHint[];
  /** Every `locations.X` / `switches.X` / … the files mention, whatever else went wrong (a rename is what makes them not type-check). */
  refs: MapReference[];
  /** The programs as IR (`ir.ts`), one per `program()` in order — what eudplib builds into the map on save. A map with any needs StarCraft: Remastered. */
  ir: Program[];
  /** No errors: `triggers` and `ir` are the complete output. */
  ok: boolean;
}

export interface CompileOptions {
  /** The standard library's declarations (`lib.es2022.d.ts` and what it references, concatenated). */
  lib: string;
}

export { LowerError };

/** `main.ts`, `./x/y.ts`, `x\y.ts` → `x/y.ts`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+/g, "/");
}

/** Compile a script against a map's names. Never throws for script errors — read `diagnostics`. */
export function compileScript(ts: typeof TS, files: ScriptFiles, names: ScriptNames, options: CompileOptions): CompileResult {
  const diagnostics: ScriptDiagnostic[] = [];
  const result = (extra: Partial<CompileResult> = {}): CompileResult => {
    diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    return { triggers: [], sources: [], strings: [], variables: [], programs: [], buildTime: [], hints: [], refs, ir: [], ...extra, diagnostics, ok: diagnostics.length === 0 };
  };

  const refs: MapReference[] = [];
  const scripts = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) scripts.set(normalizePath(path), text);
  if (!scripts.has(ENTRY_FILE)) {
    diagnostics.push({ file: ENTRY_FILE, line: 1, column: 1, endLine: 1, endColumn: 1, message: `The script has no ${ENTRY_FILE}; that is the file a build starts from.`, source: "compiler" });
    return result();
  }
  const fileNames = [...scripts.keys()];
  const texts = new Map<string, string>([...scripts, [DECLARATIONS_FILE, generateDeclarations(names)], [LIB_FILE, options.lib]]);

  /* ── Check ── */
  const compilerOptions: TS.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, types: [], sourceMap: true, noLib: false,
  };
  const outputs = new Map<string, string>();
  const host: TS.CompilerHost = {
    getSourceFile: (name) => {
      const text = texts.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
    },
    getDefaultLibFileName: () => LIB_FILE,
    writeFile: (name, text) => { outputs.set(name, text); },
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => texts.has(f),
    readFile: (f) => texts.get(f),
  };
  const program = ts.createProgram([...fileNames, DECLARATIONS_FILE], compilerOptions, host);
  const checker = program.getTypeChecker();
  const position = (sf: TS.SourceFile, start: number, end: number) => {
    const a = sf.getLineAndCharacterOfPosition(start);
    const b = sf.getLineAndCharacterOfPosition(end);
    return { line: a.line + 1, column: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 };
  };
  const nodeError = (node: TS.Node, message: string, source: ScriptDiagnostic["source"] = "compiler") => {
    const sf = node.getSourceFile();
    const pos = position(sf, node.getStart(sf), node.getEnd());
    // A line the plan already faulted needs no second message from the lowering.
    if (planned.has(`${sf.fileName}:${pos.line}`) && source === "compiler") return;
    diagnostics.push({ file: sf.fileName, ...pos, message, source });
  };
  // Filled in after the programs are planned; empty until then.
  const planned = new Set<string>();
  const tables = new Set([names.players, names.units, names.locations, names.switches, names.aiScripts].map((t) => t.object));
  for (const name of fileNames) {
    const sf = program.getSourceFile(name)!;
    // `locations` itself, or the `locations` of `ts.locations` through a namespace import: the library's symbol either way.
    const tableOf = (e: TS.Expression): string | null => {
      const id = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) ? e.name : null;
      const lib = id ? libraryName(ts, checker, id) : null;
      return lib && tables.has(lib) ? lib : null;
    };
    const visit = (node: TS.Node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        const object = tableOf(node.expression);
        if (object) refs.push({ file: name, ...position(sf, node.name.getStart(sf), node.name.getEnd()), object, key: node.name.text, quoted: false });
      } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        const object = tableOf(node.expression);
        if (object) refs.push({ file: name, ...position(sf, node.argumentExpression.getStart(sf), node.argumentExpression.getEnd()), object, key: node.argumentExpression.text, quoted: true });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  // The whole program, not just the scripts: a broken declaration file is a bug worth seeing.
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const sf = d.file;
    const pos = sf && d.start !== undefined ? position(sf, d.start, d.start + (d.length ?? 0)) : { line: 1, column: 1, endLine: 1, endColumn: 1 };
    const file = sf ? sf.fileName : ENTRY_FILE;
    const where = sf && !scripts.has(sf.fileName) ? `${sf.fileName}: ` : "";
    diagnostics.push({ file: scripts.has(file) ? file : ENTRY_FILE, ...pos, message: where + ts.flattenDiagnosticMessageText(d.messageText, "\n"), source: "typescript" });
  }
  if (diagnostics.length) return result();

  /* ── Plan the programs and the game functions ── */
  const plans = new Map<TS.Node, ProgramPlan>();
  const byPosition = new Map<string, { plan: ProgramPlan; sf: TS.SourceFile; name?: string }>();
  const fileIndex = (sf: TS.SourceFile) => fileNames.indexOf(sf.fileName);
  const buildTime: SourceRange[] = [];
  for (const name of fileNames) {
    const sf = program.getSourceFile(name)!;
    const visit = (node: TS.Node) => {
      if (ts.isCallExpression(node)) {
        const lib = libraryCallName(ts, checker, node);
        const arrow = node.arguments[0];
        if ((lib === "program" || lib === "game") && arrow && (ts.isArrowFunction(arrow) || ts.isFunctionExpression(arrow))) {
          const plan = planProgram(ts, checker, arrow, { parameters: lib === "game" });
          plans.set(arrow, plan);
          // `const award = game(…)`: the name, for the triggers' labels.
          const fnName = lib === "game" && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
          byPosition.set(`${fileIndex(sf)}:${arrow.getStart(sf)}`, { plan, sf, ...(fnName ? { name: fnName } : {}) });
          for (const e of plan.errors) nodeError(e.node, e.message);
          for (const e of plan.hoisted) buildTime.push({ file: name, ...position(sf, e.getStart(sf), e.getEnd()) });
          return; // A program inside a program is the plan's error; nothing to find below.
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    // Outside the programs, a condition or an action is a value: testing one as a boolean is a mistake TypeScript lets pass.
    checkValuesAsBooleans(ts, checker, sf, plans, (node, message) => nodeError(node, message));
  }
  if (diagnostics.length) return result();
  // The plan's errors do not stop the run: a body with a fault still lowers, so every problem shows at once.
  for (const d of diagnostics) planned.add(`${d.file}:${d.line}`);

  /* ── Emit ── */
  const emitted = program.emit(undefined, undefined, undefined, false, { before: [transformer(ts, checker, { fileIndex, planFor: (arrow) => plans.get(arrow) })] });
  for (const d of emitted.diagnostics) {
    if (d.category === ts.DiagnosticCategory.Error) diagnostics.push({ file: ENTRY_FILE, line: 1, column: 1, endLine: 1, endColumn: 1, message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), source: "typescript" });
  }
  if (diagnostics.length > planned.size) return result();
  const linked = new Map<string, LinkedFile>();
  for (const name of fileNames) {
    const base = name.replace(/\.ts$/, "");
    const js = outputs.get(`${base}.js`);
    if (js === undefined) { diagnostics.push({ file: name, line: 1, column: 1, endLine: 1, endColumn: 1, message: "The file produced no JavaScript.", source: "compiler" }); continue; }
    linked.set(name, { js, map: outputs.get(`${base}.js.map`) });
  }
  if (diagnostics.length > planned.size) return result();

  /* ── Run ── */
  const collector = new Collector();
  const runtime = createRuntime(names, collector);
  const failure = runModules(linked, ENTRY_FILE, runtime, MODULE_NAME);
  if (failure) {
    const line = failure.line ?? 1;
    diagnostics.push({ file: failure.file ?? ENTRY_FILE, line, column: failure.column ?? 1, endLine: line, endColumn: (failure.column ?? 1) + 1, message: failure.message, source: "script" });
    return result();
  }

  /* ── The triggers, and the programs as IR ── */
  const sourceOf = (at: [number, number] | null): TriggerSource | null => (at ? { file: fileNames[at[0]] ?? ENTRY_FILE, line: at[1] } : null);
  const bodies = new Map<ProgramDescriptor, Body | null>();
  const bodyOf = (d: ProgramDescriptor): Body | null => {
    let b = bodies.get(d);
    if (b !== undefined) return b;
    const found = byPosition.get(`${d.at[0]}:${d.pos}`);
    if (!found) b = null;
    else {
      try { b = newBody(found.plan, found.sf, d.hoisted(), found.name); } catch { b = null; }
    }
    bodies.set(d, b);
    return b;
  };
  const resolve = (fn: GameFunctionValue): Body | undefined => bodyOf(fn.descriptor) ?? undefined;

  const triggers: TriggerRecord[] = [];
  const sources: (TriggerSource | null)[] = [];
  const programs: ProgramInfo[] = [];
  const variables: VariableInfo[] = [];
  const hints: LineHint[] = [];
  const ir: Program[] = [];
  for (const entry of collector.entries) {
    if (entry.kind === "trigger") { triggers.push(entry.record); sources.push(sourceOf(entry.at)); continue; }
    const file = fileNames[entry.descriptor.at[0]];
    const at = sourceOf(entry.descriptor.at) ?? { file, line: 1 };
    const body = bodyOf(entry.descriptor);
    if (!body) { diagnostics.push({ file, line: at.line, column: 1, endLine: at.line, endColumn: 2, message: "program(): the body could not be found again.", source: "compiler" }); continue; }
    const owners = entry.options.owners;
    const owner = owners.find((o) => o < PLAYER_SLOTS) ?? 0;
    const emitted = new Structured({ ts, checker, body, owner, owners, perPlayer: entry.options.perPlayer, strings: collector.strings, error: (node, message, source) => nodeError(node, message, source), resolve }).run();
    const index = programs.length;
    ir.push(emitted.program);
    programs.push({ ...(emitted.program.name ? { name: emitted.program.name } : {}), owner, owners, perPlayer: entry.options.perPlayer, source: at });
    for (const d of declarations(emitted.program.body)) if (!d.temp) variables.push({ name: d.name, kind: d.kind, program: index, shared: d.shared, at: d.at, ...(d.bits ? { bits: d.bits } : {}) });
    // What would freeze the game or cannot be built is a fault of the script, said where it is.
    const check = checkProgram(emitted.program);
    for (const d of check.errors) {
      if (planned.has(`${d.at.file}:${d.at.line}`)) continue;
      diagnostics.push({ file: d.at.file, line: d.at.line, column: d.at.column, endLine: d.at.line, endColumn: d.at.column + 1, message: d.message, source: "compiler" });
    }
    hints.push(...check.hints);
  }
  return result({ ir, triggers, sources, strings: collector.strings, variables, programs, buildTime, hints });
}

/**
 * Outside `program()`, `bring(…)` is a value the game will test and `displayText(…)` a
 * value the game will run; `if (bring(…))` tests whether the object exists, and
 * `bring(…) && deaths(…)` is just `deaths(…)`. TypeScript allows both. Reported as
 * errors on every boolean position — `if`, `while`, `for`, `?:`, `!`, `&&`, `||`.
 */
function checkValuesAsBooleans(ts: typeof TS, checker: TS.TypeChecker, sf: TS.SourceFile, programs: Map<TS.Node, ProgramPlan>, error: (node: TS.Node, message: string) => void) {
  const isLibraryType = (t: TS.Type, name: string): boolean => {
    if (t.isUnion() || t.isIntersection()) return t.types.some((x) => isLibraryType(x, name));
    const decl = t.symbol?.declarations?.[0];
    return t.symbol?.name === name && !!decl && decl.getSourceFile().fileName === DECLARATIONS_FILE;
  };
  const kindOf = (e: TS.Expression): "condition" | "action" | null => {
    const t = checker.getTypeAtLocation(e);
    return isLibraryType(t, "Condition") ? "condition" : isLibraryType(t, "Action") ? "action" : null;
  };
  const short = (e: TS.Expression) => {
    const text = e.getText(sf).replace(/\s+/g, " ");
    const paren = text.indexOf("(");
    return paren > 0 ? `${text.slice(0, paren)}(…)` : text.length > 32 ? `${text.slice(0, 31)}…` : text;
  };
  const test = (e: TS.Expression | undefined) => {
    if (!e) return;
    const kind = kindOf(e);
    if (kind === "condition") error(e, `${short(e)} is a condition — a value the game tests, not a boolean. Put it in a trigger's conditions list (several conditions there must all hold), or test it in an if inside program().`);
    else if (kind === "action") error(e, `${short(e)} is an action, not a boolean: nothing happens until a trigger runs it. Put it in a trigger's actions list, or write it as a statement inside program().`);
  };
  const visit = (node: TS.Node) => {
    if (programs.has(node)) return;
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) test(node.expression);
    else if (ts.isForStatement(node)) test(node.condition);
    else if (ts.isConditionalExpression(node)) test(node.condition);
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) test(node.operand);
    else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { test(node.left); test(node.right); }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
