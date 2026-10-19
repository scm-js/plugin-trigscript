import ts from "typescript";
import { compileScript } from "../compiler/compiler";
import { scriptFiles } from "./script-files.mts";
import { defaultScriptNames } from "../compiler/names";
import { defaultLib } from "../bundle/lib.mjs";
const r = compileScript(ts, scriptFiles(process.argv[2]), defaultScriptNames(), { lib: defaultLib() });
const show = (s: any, d = 0): void => {
  const pad = "  ".repeat(d);
  const line = s.at?.line ?? "";
  if (["for", "while", "do", "unrolled", "if", "block"].includes(s.kind)) {
    console.log(`${pad}${s.kind} L${line}${s.cond ? " cond=" + JSON.stringify(s.cond).slice(0, 160) : ""}`);
    for (const k of ["body", "then", "else", "update"]) if (Array.isArray(s[k])) { console.log(`${pad} ${k}:`); s[k].forEach((x: any) => show(x, d + 2)); }
    if (s.iterations) console.log(`${pad} (${s.iterations.length} iterations)`);
  } else console.log(`${pad}${s.kind} L${line} ${JSON.stringify(s.value ?? s.init ?? s.target ?? "").slice(0, 140)}`);
};
for (const p of r.ir) p.body.forEach((s: any) => show(s));
