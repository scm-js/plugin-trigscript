/**
 * The plugin's words: English is the key, `ko.ts` has the Korean, and the editor's
 * `api.i18n.t` picks the language. What is here is for code that has no `api` in reach —
 * the pure helpers the tests call and the compiler's worker — and takes a `Translate`
 * with `english` as its default: the same grammar as the editor's (`{name}`,
 * `{n, plural, one {…} other {…}}`, `{x, select, …}`, `{name|을}`), filled in English.
 * The language of TrigScript itself, and what a command or service returns, stays English.
 */
export type Params = Record<string, string | number>;
export type Translate = (text: string, params?: Params) => string;

/** A string kept in a table, English, shown through `t` where it is shown; the marker lets `tests/ko.test.ts` find it. */
export const msg = (text: string): string => text;

/** The index of the brace that closes the one at `at`, or -1. */
function closing(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** `one {…} other {…}` as a map from the selector to its text. */
function branches(s: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const key = s.slice(i, open).trim();
    const end = closing(s, open);
    if (end < 0) break;
    out.set(key, s.slice(open + 1, end));
    i = end + 1;
  }
  return out;
}

function fill(inner: string, params: Params): string {
  const m = /^\s*(\w+)\s*(?:,\s*(plural|select)\s*,([\s\S]*)|\|[^{}]*)?$/.exec(inner);
  if (!m) return `{${inner}}`;
  const value = params[m[1]];
  if (!m[2]) return value === undefined ? `{${inner}}` : String(value);
  const choices = branches(m[3]);
  if (m[2] === "plural") {
    const n = Number(value);
    const text = choices.get(`=${n}`) ?? (n === 1 ? choices.get("one") : undefined) ?? choices.get("other") ?? "";
    return format(text.replace(/#/g, String(n)), params);
  }
  return format(choices.get(String(value)) ?? choices.get("other") ?? "", params);
}

function format(text: string, params: Params): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    if (text[i] !== "{") { out += text[i++]; continue; }
    const end = closing(text, i);
    if (end < 0) { out += text.slice(i); break; }
    out += fill(text.slice(i + 1, end), params);
    i = end + 1;
  }
  return out;
}

/** The text as English shows it: its placeholders filled, the plural's branch chosen. */
export const english: Translate = (text, params) => (params ? format(text, params) : text.includes("{") ? format(text, {}) : text);
