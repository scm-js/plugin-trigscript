/**
 * The ledger (`ledger/`, `tests/ledger.ts`) by step: how much of each step a map of our own takes, and what it still
 * refuses, with the reason it gives.
 *
 *   npx tsx scripts/ledger.mts                  the table, step by step
 *   npx tsx scripts/ledger.mts --write          each script's first line made what a map of our own makes of it now
 *   npx tsx scripts/ledger.mts --check <files>  those scripts alone: compiled, and whether their first lines hold
 *   npx tsx scripts/ledger.mts --missing        kinds of the IR and names of the library no script reaches yet
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LEDGER_DIR, agrees, apiNames, headerFor, irKeys, irKinds, outcome, parseRow, readLedger, uses, type Row } from "../tests/ledger.ts";

const args = process.argv.slice(2);
const mode = args[0] ?? "--table";

if (mode === "--check") {
  for (const path of args.slice(1)) {
    const file = relative(LEDGER_DIR, resolve(path)).split("\\").join("/");
    const source = readFileSync(resolve(path), "utf8");
    const row = parseRow(file, source);
    const o = outcome({ file, source });
    const now = o.error ? `does not compile: ${o.error}` : headerFor(typeof row === "string" ? 0 : row.step, o).replace(/^\/\/ ledger: step \d+, /, "");
    const verdict = typeof row === "string" ? row : agrees(row, o) ? "holds" : "DIFFERS";
    // (What the script compiled to, so that a feature the front end worked out when the map is built shows.)
    const kinds = [...irKeys(o.ir)].filter((k) => !["block", "const", "var", "remark"].includes(k)).sort().join(" ");
    console.log(`${file}\n  now: ${now}\n  first line: ${verdict}\n  IR: ${kinds}`);
  }
  process.exit(0);
}

const rows = readLedger();

if (mode === "--missing") {
  const seen = new Set<string>();
  for (const row of rows) irKeys(outcome(row).ir, seen);
  console.log("kinds of the IR no script reaches:", irKinds().filter((k) => !seen.has(k)).join(", ") || "none");
  console.log("names no script uses:", apiNames().filter((n) => !rows.some((r) => uses(r, n))).map((n) => n.name).join(", ") || "none");
  process.exit(0);
}

const results = rows.map((row) => ({ row, o: outcome(row) }));

if (mode === "--write") {
  let changed = 0;
  for (const { row, o } of results) {
    if (o.error) { console.error(`${row.file}: does not compile — ${o.error}`); continue; }
    if (agrees(row, o)) continue;
    const path = join(LEDGER_DIR, row.file);
    const [, ...rest] = row.source.split("\n");
    writeFileSync(path, [headerFor(row.step, o), ...rest].join("\n"));
    console.log(`${row.file}: ${headerFor(row.step, o).replace(/^\/\/ ledger: /, "")}`);
    changed++;
  }
  console.log(`${changed} first lines written`);
  process.exit(0);
}

const byStep = new Map<number, { row: Row; takes: boolean; reason?: string }[]>();
for (const { row, o } of results) byStep.set(row.step, [...(byStep.get(row.step) ?? []), { row, takes: o.takes, reason: o.reason ?? o.error }]);
for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
  const list = byStep.get(step)!;
  const taken = list.filter((x) => x.takes).length;
  console.log(`\nStep ${step}: ${taken} of ${list.length} taken`);
  for (const x of list.filter((y) => !y.takes)) console.log(`  ${x.row.file} — ${x.row.what}\n      ${x.reason}`);
}
