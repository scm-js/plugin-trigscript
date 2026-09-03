/**
 * `npm run bundle`: Monaco, bundled here rather than fetched from a CDN's bundler.
 *
 * Monaco's ESM build imports its stylesheets and lazy-loads its language chunks, and
 * the on-the-fly bundlers (jsDelivr's `+esm`, esm.sh) turn each lazy chunk into a
 * standalone bundle carrying a second copy of the editor core — the tokenizer and the
 * language service register with the wrong instance and the editor ends up with no
 * highlighting and no IntelliSense. So the plugin carries its own build, three files
 * under `dist/`: the editor with the TypeScript language (CSS injected by the module
 * itself, the codicon font inlined), and the two workers. They are served by jsDelivr's
 * GitHub mirror at the tag `monaco.ts` names; bump the tag when this changes.
 */
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const mime = (p) => (p.endsWith(".ttf") ? "font/ttf" : p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png" : "application/octet-stream");

async function replaceAsync(text, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

/** A `.css` import becomes a module that appends a `<style>`; relative `url()`s are inlined. */
const cssInject = {
  name: "css-inject",
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const raw = await readFile(args.path, "utf8");
      const css = await replaceAsync(raw, /url\((['"]?)([^'")]+)\1\)/g, async (m, _q, p) => {
        if (/^(data:|https?:|#)/.test(p)) return m;
        const file = join(dirname(args.path), p.split(/[?#]/)[0]);
        const bytes = await readFile(file);
        return `url("data:${mime(file)};base64,${bytes.toString("base64")}")`;
      });
      return { contents: `const s=document.createElement("style");s.setAttribute("data-monaco","");s.textContent=${JSON.stringify(css)};document.head.appendChild(s);`, loader: "js" };
    });
  },
};

await build({
  entryPoints: {
    monaco: "bundle/monaco.entry.ts",
    "ts.worker": "monaco-editor/language/typescript/ts.worker",
    "editor.worker": "monaco-editor/editor/editor.worker",
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  minify: true,
  legalComments: "linked",
  plugins: [cssInject],
  loader: { ".ttf": "dataurl" },
  logLevel: "info",
});
