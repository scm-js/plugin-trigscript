/**
 * JSX in a script: a text the game shows, written as elements. In a program the structured compiler puts it together in
 * the game (`structured.ts#jsx`); outside one, where the script runs when it is built, `jsxAtBuild` makes the same text
 * there. The game facts behind it are the UI spike's (TrigScript 4, S2, played 2026-10-16): eleven text lines; ■ □ ●
 * one width; a colour code takes no width; after 05 (grey) every later code on its line is ignored.
 */

/** The colours a text in the game takes, by name: the colour code each one is. Measured in Remastered (the UI spike). */
export const TEXT_COLORS = Object.freeze({
  white: 0x04,
  grey: 0x05,
  red: 0x08,
  orange: 0x11,
  yellow: 0x03,
  paleYellow: 0x19,
  green: 0x07,
  darkGreen: 0x18,
  sage: 0x1d,
  teal: 0x0f,
  cyan: 0x1f,
  blue: 0x0e,
  lightBlue: 0x1c,
  paleBlue: 0x02,
  purple: 0x10,
  lavender: 0x1e,
  brown: 0x15,
  cream: 0x1b,
} as const);
export type TextColorName = keyof typeof TEXT_COLORS;

/** The colour of a line that says none. */
export const DEFAULT_COLOR = TEXT_COLORS.white;
/** A cell that is filled, in its colour, and one that is empty: the same width (the spike's B1). */
export const FILLED_CELL = "■";
export const EMPTY_CELL = "□";
/** An empty cell's colour: it reads on black and over terrain, and no piece is lavender (the spike's second round). */
export const EMPTY_COLOR = TEXT_COLORS.lavender;

/** The elements a text is made of, with the attributes each takes. */
export const JSX_ELEMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  line: ["color"],
  span: ["color"],
  cell: ["color"],
  bar: ["value", "max", "width", "color"],
});

/** The colour code for what a script wrote as a colour: a name of TEXT_COLORS, or the code itself (0 for none). */
export function colorCode(v: unknown): number | null {
  if (typeof v === "string") return Object.hasOwn(TEXT_COLORS, v) ? TEXT_COLORS[v as TextColorName] : null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xff) return v;
  return null;
}

/* ── Outside a program: the same text, made when the script is built ── */

/** A colour to be put back after an element that changed it: the element around it fills in its own. */
const RESTORE = "\u0000";

/** What an element gives when the script is built: its text, and whether it is lines (a `<line>`, or holds some). */
class Built extends String {
  readonly lines: boolean;
  constructor(text: string, lines: boolean) { super(text); this.lines = lines; }
}

const flat = (children: unknown[]): unknown[] => children.flatMap((c) => (Array.isArray(c) ? flat(c) : [c]));

/** The children one after another, a line break before each line but the first thing written — as in the game. */
function joined(children: unknown[]): { text: string; lines: boolean } {
  let text = "", lines = false, any = false;
  for (const c of flat(children)) {
    if (c === null || c === undefined || typeof c === "boolean") continue;
    const isLine = c instanceof Built && c.lines;
    if (isLine && any) text += "\n";
    text += String(c);
    any = true;
    lines ||= isLine;
  }
  return { text, lines };
}

/** The script's JSX when it runs at build time (the factory `__jsx`): the text the game would be shown. */
export function jsxAtBuild(tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]): string {
  const p = props ?? {};
  if (tag === JSX_FRAGMENT) { const j = joined(children); return new Built(j.text, j.lines) as unknown as string; }
  if (typeof tag !== "string" || !Object.hasOwn(JSX_ELEMENTS, tag)) throw new Error(`<${String(tag)}> is not an element of a text: they are ${Object.keys(JSX_ELEMENTS).map((t) => `<${t}>`).join(", ")}.`);
  const code = (fallback: number | null) => {
    if (p.color === undefined) return fallback;
    const c = colorCode(p.color);
    if (c === null) throw new Error(`<${tag}>'s color is one of ${Object.keys(TEXT_COLORS).join(", ")}, or a colour code; got ${JSON.stringify(p.color)}.`);
    return c;
  };
  const ch = (c: number | null) => (c ? String.fromCharCode(c) : "");
  const inside = (own: number) => joined(children).text.split(RESTORE).join(ch(own));
  switch (tag) {
    case "line": { const own = code(DEFAULT_COLOR)!; return new Built(tidy(ch(own) + inside(own)), true) as unknown as string; }
    case "span": { const own = code(null); return new Built(own === null ? joined(children).text : ch(own) + inside(own) + RESTORE, false) as unknown as string; }
    case "cell": { const own = code(0)!; return new Built(own ? ch(own) + FILLED_CELL + RESTORE : ch(EMPTY_COLOR) + EMPTY_CELL + RESTORE, false) as unknown as string; }
    case "bar": {
      const value = Number(p.value ?? 0), max = Number(p.max ?? 0), width = Number(p.width ?? 10);
      const filled = max > 0 ? Math.max(0, Math.min(width, Math.floor((value * width) / max))) : 0;
      return new Built(ch(code(TEXT_COLORS.green)) + FILLED_CELL.repeat(filled) + ch(EMPTY_COLOR) + EMPTY_CELL.repeat(width - filled) + RESTORE, false) as unknown as string;
    }
  }
  throw new Error(`<${tag}> is not an element of a text.`);
}

/** What `<>…</>` passes as its tag. */
export const JSX_FRAGMENT = "__fragment";

/** A line's text with what changes nothing taken out: a colour code that another follows, or that ends it. */
function tidy(s: string): string {
  return s.replace(/[\x01-\x08\x0e-\x1f\u0000]+(?=[\x01-\x08\x0e-\x1f]|$)/g, "").replace(/\u0000/g, "");
}

/** The text a built value of JSX is, wherever it ends up: what is left to put back is the default colour. */
export function builtText(v: unknown): string | undefined {
  return v instanceof Built ? String(v).split(RESTORE).join(String.fromCharCode(DEFAULT_COLOR)) : undefined;
}
