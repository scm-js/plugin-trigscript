/**
 * The script's files as a tree, and what moving one takes. A file's name has its folders
 * in it (`waves/spawn.ts`) and that is all a folder is: there is no empty one, as in the
 * archive the files are kept in. Moving or renaming a file, or a folder with what is in
 * it, rewrites the imports that pointed at what moved and the moved files' own, so the
 * script compiles after as it did before. Pure over strings, so the tests need no editor.
 */
import { ENTRY_FILE, normalizePath, type ScriptFiles } from "./compiler/compiler";
import { resolveModule } from "./compiler/link";

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
}

export interface TreeFolder {
  kind: "folder";
  name: string;
  /** Without a slash at its end: `waves`, `waves/bosses`. */
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

/** Folders before files, each by name; the entry file first of all. */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const path of paths.map(normalizePath)) {
    const parts = path.split("/");
    let at = root;
    for (const [i, part] of parts.slice(0, -1).entries()) {
      let next = at.children.find((c): c is TreeFolder => c.kind === "folder" && c.name === part);
      if (!next) { next = { kind: "folder", name: part, path: parts.slice(0, i + 1).join("/"), children: [] }; at.children.push(next); }
      at = next;
    }
    at.children.push({ kind: "file", name: parts[parts.length - 1], path });
  }
  const sort = (folder: TreeFolder) => {
    folder.children.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1)
        : a.path === ENTRY_FILE ? -1 : b.path === ENTRY_FILE ? 1
          : a.name.localeCompare(b.name));
    for (const c of folder.children) if (c.kind === "folder") sort(c);
  };
  sort(root);
  return root.children;
}

/** The folder a path is in; "" at the top. */
export const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** The files under a folder, however deep. */
export const filesUnder = (paths: readonly string[], folder: string) => paths.filter((p) => p.startsWith(`${folder}/`));

/** A folder's name as it may be typed: parts of letters, digits, _ - and ., none of them `.` or `..`. */
export const FOLDER_NAME = /^(?:[A-Za-z0-9_\-.]+\/)*[A-Za-z0-9_\-.]+$/;
export const validFolder = (name: string) => FOLDER_NAME.test(name) && !name.split("/").some((p) => p === "." || p === "..");

/**
 * Labels for tabs: the file's own name, and its folder beside it for those that share one
 * (`spawn.ts waves`, `spawn.ts bosses`; the top says `.`).
 */
export function tabLabels(paths: readonly string[]): Map<string, { label: string; folder?: string }> {
  const byName = new Map<string, string[]>();
  for (const p of paths) { const name = p.split("/").pop()!; byName.set(name, [...(byName.get(name) ?? []), p]); }
  const out = new Map<string, { label: string; folder?: string }>();
  for (const [name, same] of byName) for (const p of same) out.set(p, same.length > 1 ? { label: name, folder: folderOf(p) || "." } : { label: name });
  return out;
}

/* ── Imports ── */

/** One module specifier in a text: the offsets of what is between the quotes. */
export interface Specifier {
  text: string;
  start: number;
  end: number;
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * The module specifiers of a text: the string after `from`, after a bare `import`, and
 * inside `import(` / `require(`. Comments, other strings and template literals are walked
 * over, so a path inside one is not taken for an import.
 */
export function findSpecifiers(text: string): Specifier[] {
  const out: Specifier[] = [];
  /** The last two things before here that were not space or a comment: a word, or a character. */
  let last = "";
  let before = "";
  const push = (token: string) => { before = last; last = token; };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const imported = last === "from" || last === "import" || (last === "(" && (before === "import" || before === "require"));
      if (imported && text[j] === c) out.push({ text: text.slice(i + 1, j), start: i + 1, end: j });
      push("string");
      i = j + 1;
      continue;
    }
    if (c === "`") {
      // A template: to its closing quote, a `${ … }` inside it walked by its braces.
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (depth === 0 && text[j] === "`") break;
        if (text[j] === "$" && text[j + 1] === "{") { depth++; j += 2; continue; }
        if (depth > 0 && text[j] === "{") depth++;
        if (depth > 0 && text[j] === "}") depth--;
        j++;
      }
      push("string");
      i = j + 1;
      continue;
    }
    if (WORD.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(text[j])) j++;
      push(text.slice(i, j));
      i = j;
      continue;
    }
    if (!/\s/.test(c)) push(c);
    i++;
  }
  return out;
}

/** `waves/spawn.ts` seen from `tests/waves.test.ts` → `../waves/spawn.ts`. Always starts with `./` or `../`. */
export function relativePath(from: string, to: string): string {
  const a = folderOf(from).split("/").filter(Boolean);
  const b = to.split("/");
  let same = 0;
  while (same < a.length && same < b.length - 1 && a[same] === b[same]) same++;
  const up = a.length - same;
  const rest = b.slice(same).join("/");
  return up === 0 ? `./${rest}` : `${"../".repeat(up)}${rest}`;
}

/** The specifier for `target` from `from`, written the way `was` was: with `.ts`, with `.js`, as a folder with an index, or bare. */
function respell(from: string, target: string, was: string): string {
  const path = relativePath(from, target);
  if (/\.ts$/.test(was)) return path;
  if (/\.js$/.test(was)) return path.replace(/\.ts$/, ".js");
  // A folder named for its index stays one, unless that would leave nothing but `.`, which names no file.
  if (/\/index\.ts$/.test(target) && !/(^|\/)index$/.test(was) && path !== "./index.ts") return path.replace(/\/index\.ts$/, "");
  return path.replace(/\.ts$/, "");
}

/* ── Moves ── */

/** Old path → new path, for every file that moves. A folder's move is one of these per file under it. */
export type Moves = ReadonlyMap<string, string>;

/** What moving `from` to `to` moves: the file itself, or every file under the folder. */
export function movesOf(paths: readonly string[], from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  if (from === to) return out;
  if (paths.includes(from)) out.set(from, to);
  else for (const p of filesUnder(paths, from)) out.set(p, `${to}${p.slice(from.length)}`);
  return out;
}

/** Why a set of moves cannot be made, or null: the entry file stays where it is, and nothing lands on a file that stays. */
export function refuseMoves(paths: readonly string[], moves: Moves): string | null {
  if (moves.has(ENTRY_FILE)) return `${ENTRY_FILE} is where the script starts: it stays where it is.`;
  const stay = new Set(paths.filter((p) => !moves.has(p)));
  for (const to of moves.values()) if (stay.has(to)) return `There is already a ${to}.`;
  return null;
}

export interface Moved {
  files: ScriptFiles;
  /** Imports rewritten, over all files. */
  imports: number;
  /** The files whose text changed, by their new paths. */
  edited: string[];
}

/**
 * The files after the moves, every relative import still naming the file it named: those
 * of a file that stayed and pointed at one that moved, and those of a file that moved,
 * whatever they pointed at. An import that named no file before is left as it was.
 */
export function applyMoves(files: ScriptFiles, moves: Moves): Moved {
  const names = new Set(Object.keys(files).map(normalizePath));
  const out: ScriptFiles = {};
  const edited: string[] = [];
  let imports = 0;
  for (const [raw, text] of Object.entries(files)) {
    const path = normalizePath(raw);
    const now = moves.get(path) ?? path;
    let next = text;
    // Right to left, so the offsets before an edit stay valid.
    for (const s of findSpecifiers(text).reverse()) {
      const target = resolveModule(names, path, s.text);
      if (!target) continue;
      const targetNow = moves.get(target) ?? target;
      if (now === path && targetNow === target) continue;
      const spelled = respell(now, targetNow, s.text);
      if (spelled === s.text) continue;
      next = next.slice(0, s.start) + spelled + next.slice(s.end);
      imports++;
    }
    if (next !== text) edited.push(now);
    out[now] = next;
  }
  return { files: out, imports, edited };
}
