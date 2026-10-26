/**
 * What compiler/ranges.ts found: compiles a script and prints, line by line, each number of the IR that has a range.
 *
 *   npx tsx scripts/show-ranges.mts <script.ts>        or        npx tsx scripts/show-ranges.mts -e '<program body>'
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { compileScript } from "../compiler/compiler";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
import { scriptFiles } from "./script-files.mts";

const [a, b] = process.argv.slice(2);
const files = a === "-e" ? { "main.ts": `import { program, sleep, frames, deaths, units, P8 } from "trigscript";\nprogram(() => {\n${b}\n});` } : scriptFiles(a);
const r = compileScript(ts, files, defaultScriptNames(), { lib: defaultLib() });
for (const d of r.diagnostics) console.log(`${d.file}:${d.line}: ${d.message}`);
const source = (files as Record<string, string>)["main.ts"]?.split("\n") ?? [];
const seen = new Set<object>();
const rows: string[] = [];
const walk = (x: unknown) => {
  if (!x || typeof x !== "object" || seen.has(x)) return;
  seen.add(x);
  if (Array.isArray(x)) { x.forEach(walk); return; }
  const o = x as Record<string, unknown>;
  if (Array.isArray(o.range)) {
    const at = (o.at as { line?: number } | undefined)?.line;
    const what = o.kind === "binary" ? `${o.op}` : o.kind === "var" ? `var ${String(o.id)}` : o.kind === "const" ? `${o.value}` : String(o.kind);
    rows.push(`${String(at ?? "").padStart(4)}  ${what.padEnd(16)} ${JSON.stringify(o.range)}${typeof o.label === "string" ? "  " + o.label : ""}`);
  }
  for (const v of Object.values(o)) walk(v);
};
walk(r.ir);
console.log(rows.join("\n"));
void source; void readFileSync;
