/**
 * The TrigScript compiler: the script's files are a real TypeScript program, checked
 * against the generated declarations and the standard library, emitted as CommonJS and
 * *run*. Running is what defines the raw level — every `trigger()` the script calls,
 * through whatever helpers and loops it likes, records one trigger — and `program()`
 * bodies are the structured level: the run records where each body is and the values
 * of its build-time parts (`hoist.ts`), and `structured.ts` lowers the body to a
 * death-counter state machine through `lower.ts`.
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
import { libraryName, planProgram, transformer, type ProgramPlan } from "./hoist";
import { runModules, type LinkedFile } from "./link";
import { Allocator, LowerError, Machine, storageLabel } from "./lower";
import type { ScriptNames } from "./names";
import { Collector, createRuntime, type ScriptString } from "./runtime";
import { Structured } from "./structured";

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

export interface VariableInfo {
  name: string;
  kind: "number" | "boolean";
  /** Where it lives: "P3 · Cantina (Unused)" or "Switch 256". */
  storage: string;
  /** Death counter (numbers). */
  player?: number;
  unit?: number;
  /** Switch index (booleans). */
  switch?: number;
}

export interface ProgramInfo {
  /** The player the program runs as (0-based). */
  owner: number;
  /** Index into `triggers` of the program's first trigger. */
  start: number;
  count: number;
  /** Where the `program(` call is. */
  source: TriggerSource;
}

export interface CompileResult {
  triggers: TriggerRecord[];
  /** Per trigger, where it came from; null for a hyper trigger. */
  sources: (TriggerSource | null)[];
  /** Local string table: a record's `text` / `wav` field `k > 0` means `strings[k - 1]`. */
  strings: ScriptString[];
  diagnostics: ScriptDiagnostic[];
  /** The programs' variables (temporaries and program counters included), in allocation order. */
  variables: VariableInfo[];
  programs: ProgramInfo[];
  /** No errors: `triggers` is the complete output. */
  ok: boolean;
}

export interface CompileOptions {
  /** The standard library's declarations (`lib.es2022.d.ts` and what it references, concatenated). */
  lib: string;
  /** Death counters (player, unit) the map's hand triggers use; variables avoid them. */
  reservedDeaths?: readonly (readonly [number, number])[];
  /** Switches the map's hand triggers use or name; variables avoid them. */
  reservedSwitches?: readonly number[];
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
    return { triggers: [], sources: [], strings: [], variables: [], programs: [], ...extra, diagnostics, ok: diagnostics.length === 0 };
  };

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

  /* ── Plan the programs ── */
  const plans = new Map<TS.Node, ProgramPlan>();
  const byPosition = new Map<string, ProgramPlan>();
  const fileIndex = (sf: TS.SourceFile) => fileNames.indexOf(sf.fileName);
  for (const name of fileNames) {
    const sf = program.getSourceFile(name)!;
    const visit = (node: TS.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && libraryName(ts, checker, node.expression) === "program") {
        const arrow = node.arguments[0];
        if (arrow && (ts.isArrowFunction(arrow) || ts.isFunctionExpression(arrow))) {
          const plan = planProgram(ts, checker, arrow);
          plans.set(arrow, plan);
          byPosition.set(`${fileIndex(sf)}:${arrow.getStart(sf)}`, plan);
          for (const e of plan.errors) nodeError(e.node, e.message);
          return; // A program inside a program is the plan's error; nothing to find below.
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
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

  /* ── Lower the programs into the list ── */
  const triggers: TriggerRecord[] = [];
  const sources: (TriggerSource | null)[] = [];
  const programs: ProgramInfo[] = [];
  const allocator = new Allocator({ reservedDeaths: options.reservedDeaths, reservedSwitches: options.reservedSwitches });
  const sourceOf = (at: [number, number] | null): TriggerSource | null => (at ? { file: fileNames[at[0]] ?? ENTRY_FILE, line: at[1] } : null);
  for (const entry of collector.entries) {
    if (entry.kind === "trigger") { triggers.push(entry.record); sources.push(sourceOf(entry.at)); continue; }
    const plan = byPosition.get(`${entry.descriptor.at[0]}:${entry.descriptor.pos}`);
    const file = fileNames[entry.descriptor.at[0]];
    const sf = program.getSourceFile(file)!;
    const at = sourceOf(entry.descriptor.at) ?? { file, line: 1 };
    if (!plan) { diagnostics.push({ file, line: at.line, column: 1, endLine: at.line, endColumn: 2, message: "program(): the body could not be found again.", source: "compiler" }); continue; }
    let values: unknown[];
    try {
      values = entry.descriptor.hoisted();
    } catch (err) {
      diagnostics.push({ file, line: at.line, column: 1, endLine: at.line, endColumn: 2, message: `program(): ${(err as Error).message}`, source: "script" });
      continue;
    }
    let machine: Machine;
    try {
      const comment = entry.options.comments ? (text: string) => collector.localString({ text }) : undefined;
      const units = entry.options.variableUnits.length ? new Allocator({ units: entry.options.variableUnits, reservedDeaths: options.reservedDeaths, reservedSwitches: options.reservedSwitches }) : allocator;
      machine = new Machine({ owner: entry.options.owner, allocator: units, comment });
    } catch (err) {
      diagnostics.push({ file, line: at.line, column: 1, endLine: at.line, endColumn: 2, message: (err as LowerError).message, source: "compiler" });
      continue;
    }
    const start = triggers.length;
    new Structured({ ts, checker, sf, plan, values, machine, error: (node, message) => nodeError(node, message) }).run();
    triggers.push(...machine.triggers);
    for (const line of machine.lines) sources.push({ file, line });
    programs.push({ owner: entry.options.owner, start, count: machine.triggers.length, source: at });
    if (machine.allocator !== allocator) for (const v of machine.allocator.variables) allocator.variables.push(v);
  }
  const variables: VariableInfo[] = allocator.variables.map((v) => v.kind === "dc"
    ? { name: v.name, kind: "number", storage: storageLabel(v), player: v.player, unit: v.unit }
    : { name: v.name, kind: "boolean", storage: storageLabel(v), switch: v.index });
  return result({ triggers, sources, strings: collector.strings, variables, programs });
}
