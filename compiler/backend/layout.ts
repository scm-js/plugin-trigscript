/**
 * A map of our own (TrigScript 4, the backend: our own layout and start-up). A graph (`graph.ts`) laid out as the
 * game's triggers at fixed addresses, and the few triggers of the map's own TRIG section that hand the game's trigger
 * walk to them — no eudplib, no Python.
 *
 * Remastered keeps a map's string section at 0x191943C8 (eudplib counts on it: `payload_offset` in its
 * `maprw/injector/payload_init.py`), so what is put after the strings is at an address known when the map is built:
 * the payload needs no relocation in the game. The start-up is eudplib's stage 1, as small as it goes, in the
 * triggers of every player the map gives a human or a computer: the player's last trigger node is found by reading
 * their trigger list (0x51A284 + 12 × player, the last node) a bit at a time, and that node's next pointer is set to
 * the player's entry in the payload. The start-up's triggers are not preserved: each runs once.
 *
 * Every player's list is then their entry alone, and the game walks each list once a frame, P1's first. The entry
 * sends the walk on through a gate, which lets it into the programs only when no player before this one is in the
 * game — so they run once a frame, from the list of the first player still there, and go on when a player leaves
 * (TrigScript 4, step 7). The game empties a leaver's list by following its next pointers, zeroing each node's two
 * pointers and freeing it (measured in the lifted game): so only the entry is ever reachable from a list, its next
 * pointer back at the list's end whenever the walk is not in it, as eudplib's runner keeps its own. Each program's
 * run then wakes or not, and the walk ends at a next pointer of 0x80000000 (it stops at a pointer with its top bit
 * set, as a list's own end is).
 *
 * In memory a trigger is a node: the previous and the next pointer, 16 conditions of 20 bytes, 64 actions of 32, the
 * flags (4: preserved) and 28 bytes of players. A condition or an action names a dword by its EPD (its distance from
 * the deaths table in dwords) in its player field; a mask goes in its first field, with 'SC' in its last.
 *
 * The game reads no more of a node than its pointers, its conditions up to the first of kind 0, its actions up to the
 * first of kind 0, its flags and its current action (the last byte of the players, which it writes each time the
 * trigger runs): the rest is another trigger's, or data's (`holds`). So the triggers are stacked as eudplib stacks its own
 * (`stack_objects` in its allocator): each where none of the dwords it holds is another's, from where the last one
 * went on — a trigger of a few conditions and actions in a little over 200 bytes, not 2,408. A row a doubling trigger
 * walks (`Graph.rows`) is stacked as one, its triggers 2,408 bytes apart.
 */
import { AFTER_END, END, NOW, PASS_END, TRIGGER_BYTES, TRIGGER_OFF, TRIGGER_ON, type Act, type Cond, type Dword, type Graph, type Value } from "./graph";
import { TRIGGER_LISTS, WAKE_AT, WAKE_NEXT, WAKE_TICK } from "./emit";
import type { ScriptString } from "../runtime";
import type { TriggerRecord } from "../../vendor/triggers";

export const STRINGS = 0x191943c8;
const DEATHS = 0x58a364;
const CURRENT_PLAYER = 0x6509b0;
const TRIGGER_WAIT = 0x6509a0;
const MASKED = 0x4353; // 'SC'
const NODE = TRIGGER_BYTES;
const COMPARE = { atLeast: 0, atMost: 1, exactly: 10 } as const;
const MODIFIER = { set: 7, add: 8, subtract: 9 } as const;

const u = (n: number) => ((n % 2 ** 32) + 2 ** 32) % 2 ** 32;
/** An address as the player field of a Deaths / Set Deaths names it. */
export const epd = (addr: number) => u((addr - DEATHS) / 4);

export interface OwnMap {
  /** What goes after the string section (its padding to four bytes first). */
  payload: Uint8Array;
  /** The TRIG section: the start-up's triggers. */
  trig: Uint8Array;
  /** Where the payload's first trigger is in the game. */
  address: number;
  /** Where each variable's cell is, by id. */
  vars: Map<string, number>;
  /** Where each printed text's template is: the string the map gives it is to start there. */
  templates: Map<string, number>;
  /** Where each region of cell triggers (an array, a stack) starts: its first cell's trigger. */
  regions: Map<string, number>;
  /** Where each list the graph reads where it is (an array known when built) starts, and its cells' stride in dwords. */
  lists: Map<string, { at: number; stride: number }>;
  /** Where each trigger is, by label. */
  triggers: Map<string, number>;
  /** How many cell triggers hold routed variables, before the regions: the regions' cells follow them. */
  routeCells: number;
  /** The payload's cell triggers in all (routed variables, then the regions' cells), 72 bytes apart from `regions`' first or `vars`' first route. */
  cellCount: number;
  /** Where the cell triggers start. */
  cellBase: number;
}

/**
 * The dwords of a node a trigger of so many conditions and actions holds, from its start (above): its previous pointer
 * when it is in a list of the game's, its next; its conditions, and of the one after them the dwords of its kind and its
 * flags (the game asks whether a condition is switched off, then whether it is the last: measured in the lifted game);
 * its actions, and the same two of the one after them; its flags and its current action. eudplib holds the whole of the
 * condition and the action after; a cell trigger here has held only those two dwords of each since arrays were laid
 * out so, played in Remastered.
 */
function holds(conds: number, acts: number, listed: boolean): number[] {
  const out = listed ? [0, 1] : [1];
  for (let k = 0; k < 5 * conds; k++) out.push(2 + k);
  if (conds < 16) out.push(2 + 5 * conds + 3, 2 + 5 * conds + 4);
  for (let k = 0; k < 8 * acts; k++) out.push(82 + k);
  if (acts < 64) out.push(82 + 8 * acts + 6, 82 + 8 * acts + 7);
  out.push(594, 601);
  return out;
}

/**
 * The dwords a cell trigger holds (below): its next pointer, the kind and the flags of its first condition, its action,
 * the kind and the flags of the next (the game asks whether a condition or an action is switched off before whether it
 * is the last: measured in the lifted game), its flags and current action. A cell's first condition's flags are the
 * dword of the next action's kind of the cell five before, and its next action's flags the current action's dword of the
 * cell 28 before: 0 for both, and the current action's byte one neither reads.
 */
const CELL_HOLDS = [1, 5, 6, 82, 83, 84, 85, 86, 87, 88, 89, 96, 97, 594, 601];
/** A cell trigger every 72 bytes: what one holds the others do not. */
const CELL_DWORDS = 18;

/** How far back from where the last object went the next is looked for, in dwords. */
const WINDOW = 4096;

/**
 * The payload's dwords, and which are taken. An object goes at the first dword from where the last one went on where
 * none of those it holds is taken; a dword of data, in the first gap; a run of them, at the end.
 */
class Space {
  private used = new Uint8Array(1 << 16);
  /** One past the last dword taken. */
  top = 0;
  /** Where the last object went. */
  private from = 0;
  /** No free dword below this. */
  private gap = 0;
  taken(i: number): boolean { return i < this.used.length && this.used[i] === 1; }
  private take(i: number): void {
    if (i >= this.used.length) {
      const more = new Uint8Array(Math.max(2 * this.used.length, i + 1));
      more.set(this.used);
      this.used = more;
    }
    this.used[i] = 1;
    if (i >= this.top) this.top = i + 1;
  }
  /**
   * An object holding these dwords (from its start; one may name a dword twice), at or past `from`: where it goes. Unset,
   * from the first free dword a little before where the last one went: eudplib looks from where its last went on, which
   * left a third of the made-texts probe's payload empty; from the first free dword of all, a tenth less again but four
   * times as long to lay out.
   */
  stack(dwords: number[], from?: number): number {
    while (this.taken(this.gap)) this.gap++;
    let at = from ?? Math.max(this.gap, this.from - WINDOW);
    for (let k = 0; k < dwords.length;) {
      if (this.taken(at + dwords[k])) { at++; k = 0; } else k++;
    }
    for (const d of dwords) this.take(at + d);
    this.from = at;
    return at;
  }
  /** A dword of data. */
  dword(): number {
    while (this.taken(this.gap)) this.gap++;
    this.take(this.gap);
    return this.gap;
  }
  /** `n` dwords one after another, after everything. */
  run(n: number): number {
    const at = this.top;
    for (let k = 0; k < n; k++) this.take(at + k);
    this.top = at + n;
    return at;
  }
}

export interface LayoutInput {
  /** The one run, when there is one (`runs` unset). */
  graph?: Graph;
  /** The programs' runs, in the order they run each frame (`emitOwn`), each with the player it runs as (0-based). */
  runs?: { graph: Graph; owner: number }[];
  /** The byte length of the string section the payload follows. */
  strings: number;
  /** The one run's player, 0-based. */
  owner?: number;
  /** The players whose lists the payload is linked into: those the map gives a human or a computer (all eight unset). */
  players?: number[];
  /** A text's index in the map's string table (1-based), for Display Text and an action's text or sound file. */
  text: (t: string) => number;
  /** The cells of the lists the graph reads where they are, by array id. */
  arrays: Map<string, number[]>;
  /**
   * A printed text's template's index in the map's string table (1-based), for Display Text: the map maker points
   * that string at the template, which the layout puts after the triggers (`OwnMap.templates`).
   */
  template?: (id: string) => number;
  /**
   * Where each template already is, when the map maker has put it among the map's strings (the game's own table of
   * strings names only its first 64 KB in 1.16.1, which the lifted game is): the layout then leaves them out of the
   * payload. Unset, the payload holds them.
   */
  templateAt?: Map<string, number>;
  /**
   * What each dword no trigger or data holds is, 0 unset: a test fills them so, to show nothing reads them (the
   * game, among the triggers stacked in each other's room).
   */
  free?: number;
  /**
   * The map's own triggers (TrigScript 4, step 13), in the order the map's TRIG section would hold them, each with the
   * players (0-based slots among `players`) whose lists the game would copy it into. Laid out as the game's nodes in
   * the payload — a copy a player, chained after the player's entry and before their gate — in place of the TRIG
   * section, which holds the start-up alone.
   */
  triggers?: OwnTriggerInput[];
}

/** A trigger of the map's own for the layout: its record, with each condition and action as the graph has them (`game`, `record`). */
export interface OwnTriggerInput { record: TriggerRecord; conds: Cond[]; acts: Act[]; slots: number[] }

/**
 * The dwords of a variable's cell trigger (below) a routing writes — its action's destination, where it goes after —
 * and the label the walk is sent to it by.
 */
const ROUTE_DEST = "@route.dest:", ROUTE_NEXT = "@route.next:", ROUTE_CELL = "@route:";

/**
 * A graph's copies made of triggers: the layout routes a variable's cell as eudplib's build routed every read. A
 * variable that is copied keeps its value in the number of the one action of a trigger of its own —
 * Set Deaths, add — and a copy into a place is a trigger that sets the place to its constant, points that action at
 * the place and its trigger back here, and goes to it: the value added in, about 50 ns a place. A place that holds a
 * multiple of the variable other than 1 is filled a bit at a time instead: set to its constant, then one trigger a bit
 * of the cell adding that bit times the multiple (about half a microsecond a copy). Returns the variables routed.
 */
function expandCopies(graph: Graph): { graph: Graph; routed: Set<string> } {
  const out: Graph["triggers"] = [];
  const routed = new Set<string>();
  type T = Graph["triggers"][number];
  const chunks = <X,>(xs: X[]) => Array.from({ length: Math.ceil(xs.length / 64) || 1 }, (_, k) => xs.slice(64 * k, 64 * k + 64));
  /** A copy as triggers from `label` on, the last going on to `after` (`falls`: by falling through to what follows). */
  const expand = (copy: NonNullable<T["copy"]>, label: string, after: string): T[] => {
    const made: T[] = [];
    const id = copy.from;
    const from: Dword = { var: id };
    const plain = copy.into.filter((p) => (p.scale ?? 1) === 1), scaled = copy.into.filter((p) => (p.scale ?? 1) !== 1);
    const route = (j: number) => (j === 0 ? label : `${label}.route${j}`);
    const bits = (k: number) => (k === 0 && !plain.length ? label : `${label}.clear${k}`);
    if (!plain.length && !scaled.length) made.push({ label, conds: [], acts: [] });
    if (plain.length) routed.add(id);
    plain.forEach((p, j) => made.push({
      label: route(j),
      conds: [],
      acts: [
        { dword: p.dword, modifier: "set", value: p.add },
        { dword: { data: ROUTE_DEST + id }, modifier: "set", value: { epd: p.dword } },
        { dword: { data: ROUTE_NEXT + id }, modifier: "set", value: { label: j + 1 < plain.length ? route(j + 1) : scaled.length ? bits(0) : after } },
      ],
      next: ROUTE_CELL + id,
    }));
    if (!scaled.length) return made;
    chunks(scaled).forEach((part, k) => made.push({ label: bits(k), conds: [], acts: part.map((p) => ({ dword: p.dword, modifier: "set", value: p.add })) }));
    // (Only the bits the value can have, when its range is known never below zero.)
    const bits32 = copy.top === undefined ? 32 : Math.max(1, 32 - Math.clz32(copy.top));
    for (let bit = 0; bit < bits32; bit++) chunks(scaled).forEach((part, k) => made.push({
      label: `${label}.bit${bit}.${k}`,
      conds: [{ dword: from, compare: "atLeast", value: 1, mask: 2 ** bit }],
      acts: part.map((p) => ({ dword: p.dword, modifier: "add", value: u((p.scale ?? 1) * 2 ** bit) })),
    }));
    // (The last bit's trigger falls through to what follows the copy.)
    return made;
  };
  /** How many triggers a copy is. */
  const size = (copy: NonNullable<T["copy"]>) => {
    const plain = copy.into.filter((p) => (p.scale ?? 1) === 1).length, scaled = copy.into.filter((p) => (p.scale ?? 1) !== 1);
    const bits32 = copy.top === undefined ? 32 : Math.max(1, 32 - Math.clz32(copy.top));
    return plain + (scaled.length ? Math.ceil(scaled.length / 64) * (1 + bits32) : 0);
  };
  // The same copy written after several writes of its variable — the same places, from the same cell — is laid out
  // once, after the graph, and entered from each: the place it goes back to set first, as a function's return. Each
  // copy two triggers more, every copy past the first a trigger instead of its routings and bits.
  const keyOf = (copy: NonNullable<T["copy"]>) => JSON.stringify(copy);
  const sites = new Map<string, number>();
  for (const t of graph.triggers) if (t.copy && size(t.copy) > 4) sites.set(keyOf(t.copy), (sites.get(keyOf(t.copy)) ?? 0) + 1);
  const shared = new Map<string, { start: string; back: string; copy: NonNullable<T["copy"]> }>();
  graph.triggers.forEach((t, i) => {
    if (!t.copy) { out.push(t); return; }
    const after = graph.triggers[i + 1]?.label ?? END;
    const key = keyOf(t.copy);
    if ((sites.get(key) ?? 0) < 2) { out.push(...expand(t.copy, t.label, after)); return; }
    let s = shared.get(key);
    if (!s) {
      const start = `${t.label}.shared`;
      s = { start, back: `${start}.back`, copy: t.copy };
      shared.set(key, s);
    }
    out.push({ label: t.label, conds: [], acts: [{ dword: { at: s.back, field: "next" }, modifier: "set", value: { label: after } }], next: s.start });
  });
  if (shared.size) {
    // (After the graph, which goes nowhere by falling: its last trigger ends it.)
    const last = out[out.length - 1];
    if (last && last.next === undefined && !last.copy) last.next = END;
    for (const s of shared.values()) out.push(...expand(s.copy, s.start, s.back), { label: s.back, conds: [], acts: [], next: END });
  }
  return { graph: { ...graph, triggers: out }, routed };
}

export function layout(input: LayoutInput): OwnMap {
  const runs = (input.runs ?? [{ graph: input.graph!, owner: input.owner ?? 0 }]).map((r) => ({ owner: r.owner, ...expandCopies(r.graph) }));
  const players = input.players ?? [0, 1, 2, 3, 4, 5, 6, 7];
  const routed = new Set(runs.flatMap((r) => [...r.routed]));
  const pad = -input.strings & 3;
  const base = STRINGS + input.strings + pad;
  // The payload's triggers. Each run's `@wake` first: when the map's count of frames (`NOW`) has reached the one the run
  // sleeps until and its player is in the game (their list not empty), it sends the walk where the run goes on (its
  // `@init`, the first time) with the current player theirs; otherwise on to the run's tasks, or the next run. A sleep
  // writes `@wake`'s frame and where to go on; the run's end, a frame never reached. `@init`: `@wake` back to going on
  // past the program once woken.
  const wake = (i: number) => (i ? `@wake#${i}` : "@wake"), init = (i: number) => (i ? `@init#${i}` : "@init");
  const stop = "@stop", run = "@run", entry = (p: number) => `@entry${p}`, gate = (p: number) => `@gate${p}`;
  // A run with tasks: the current player set to its owner before its wake, every frame. The game set it to the player
  // whose list carries the walk (the last one's), and the wake sets it to the owner only when the program runs; the
  // tasks' turn comes while the program sleeps too, and what a task showed then, the owner did not see. (The first
  // play of the events probe, 2026-10-24: "back", printed by a task two seconds after a death, never showed.)
  const cur = (i: number) => (i ? `@cur#${i}` : "@cur");
  const before = (i: number) => (runs[i].graph.tasks ? cur(i) : wake(i));
  // (A run whose graph holds the map's events pass goes through it first.)
  const first = (i: number) => runs[i].graph.pass ?? before(i);
  // (A run whose graph holds the map's send pass: the walk goes through it after the last run, before it stops.)
  const sendPass = runs.find((r) => r.graph.after)?.graph.after;
  const after = (i: number) => (i + 1 < runs.length ? first(i + 1) : sendPass ?? stop);
  const list = (p: number) => TRIGGER_LISTS + 12 * p;
  const listEnd = (p: number) => u(~(list(p) + 4));
  // (Where each run's graph ends: the next run.)
  const ends = new Map<string, string>(runs.flatMap((_, i): [string, string][] => [[i ? `${END}#${i}` : END, after(i)], [i ? `${PASS_END}#${i}` : PASS_END, before(i)], [i ? `${AFTER_END}#${i}` : AFTER_END, stop]]));
  const endOf = (l: string) => ends.get(l) ?? l;
  // (`flags`: a node's execution flags as written, a trigger of the map's own; else preserved, or `off`.)
  type T = { label: string; conds: Cond[]; acts: Act[]; next?: string | number; prev?: number; off?: boolean; flags?: number };
  // The map's own triggers (step 13): a player's copies chained in order after their entry, the last going on to their
  // gate. They are the game's nodes, so the game runs them as it runs a TRIG section's — a trigger that is not
  // preserved is switched off once it has run, a Wait holds it in the player's wait slot — and they are reachable only
  // from the entry while the walk is in the list, so a leaver's list empties as before.
  const own = (p: number, k: number) => `@trig${k}.p${p}`;
  const chains = new Map<number, string[]>(players.map((p) => [p, (input.triggers ?? []).flatMap((t, k) => (t.slots.includes(p) ? [own(p, k)] : []))]));
  const chainTriggers: T[] = (input.triggers ?? []).flatMap((t, k) => t.slots.filter((p) => players.includes(p)).map((p): T => {
    const chain = chains.get(p)!, i = chain.indexOf(own(p, k));
    return { label: own(p, k), prev: 0, conds: t.conds, acts: t.acts, next: chain[i + 1] ?? gate(p), flags: t.record.flags };
  }));
  const triggers: T[] = runs.flatMap(({ graph, owner }, i) => [
    ...(graph.tasks ? [{ label: cur(i), conds: [], acts: [{ dword: { game: CURRENT_PLAYER }, modifier: "set", value: owner }], next: wake(i) } satisfies T] : []),
    {
      label: wake(i),
      conds: [{ dword: { var: NOW }, compare: "atLeast", value: 0 }, { dword: { game: list(owner) + 8 }, compare: "atMost", value: 0x7fffffff }],
      acts: [{ dword: { at: wake(i), field: "next" }, modifier: "set", value: { label: init(i) } }, { dword: { game: CURRENT_PLAYER }, modifier: "set", value: owner }],
      next: graph.tasks ?? after(i),
    } satisfies T,
    { label: init(i), conds: [], acts: [{ dword: { at: wake(i), field: "next" }, modifier: "set", value: { label: graph.tasks ?? after(i) } }], next: graph.triggers[0]?.label ?? after(i) } satisfies T,
    ...graph.triggers.map((t, k) => ({ label: t.label, conds: t.conds, acts: t.acts, next: t.next !== undefined ? endOf(t.next) : graph.triggers[k + 1]?.label ?? after(i), ...(t.off ? { off: true } : {}) })),
  ]);
  triggers.push(
    // (Every pass ends here: the game's wait before the next pass set to none, as eudplib's eudTurbo does, so the
    // triggers run every frame and not every few seconds.)
    { label: stop, conds: [], acts: [{ dword: { game: TRIGGER_WAIT }, modifier: "set", value: 0 }], next: 0x80000000 },
    // Each player's entry, their list's one node: the list made it alone (the start-up's triggers dropped), and the
    // walk sent on to the player's own triggers and then the gate — the next pointer goes back to the list's end at
    // `@run`, or the next frame's.
    ...players.map((p): T => ({
      label: entry(p),
      prev: list(p) + 4,
      conds: [],
      acts: [
        { dword: { game: list(p) + 8 }, modifier: "set", value: { label: entry(p) } },
        { dword: { game: list(p) + 4 }, modifier: "set", value: { label: entry(p) } },
        { dword: { at: entry(p), field: "next" }, modifier: "set", value: { label: chains.get(p)![0] ?? gate(p) } },
      ],
      next: listEnd(p),
    })),
    ...chainTriggers,
    // The gate: into the programs when each player after this one has an empty list — so the programs run from the
    // last player's list still there, after every player's own triggers, as eudplib's build runs them (its
    // RunTrigTrigger before the programs); otherwise the walk ends.
    ...players.map((p): T => ({
      label: gate(p),
      conds: players.filter((q) => q > p).map((q): Cond => ({ dword: { game: list(q) + 8 }, compare: "atLeast", value: 0x80000000 })),
      acts: [{ dword: { at: gate(p), field: "next" }, modifier: "set", value: { label: run } }],
      next: listEnd(p),
    })),
    // Every entry and gate back to ending at its list's end, the count of frames one more, then the first run.
    { label: run, conds: [], acts: [...players.flatMap((p): Act[] => [{ dword: { at: entry(p), field: "next" }, modifier: "set", value: listEnd(p) }, { dword: { at: gate(p), field: "next" }, modifier: "set", value: listEnd(p) }]), { dword: { var: NOW }, modifier: "add", value: 1 }], next: first(0) },
  );
  for (const t of runs.flatMap((r) => r.graph.triggers)) if (t.copy) throw new Error(`${t.label}: a copy was not made into triggers`);
  // The triggers stacked, a row as one.
  const space = new Space();
  const at = new Map<string, number>();
  const rowOf = new Map<string, string[]>();
  for (const row of runs.flatMap((r) => r.graph.rows ?? [])) for (const l of row) rowOf.set(l, row);
  const byLabel = new Map(triggers.map((t) => [t.label, t]));
  for (const t of triggers) {
    if (at.has(t.label)) continue;
    const row = rowOf.get(t.label) ?? [t.label];
    const n = space.stack(row.flatMap((l, i) => holds(byLabel.get(l)!.conds.length, byLabel.get(l)!.acts.length, byLabel.get(l)!.prev !== undefined).map((d) => d + (NODE / 4) * i)));
    row.forEach((l, i) => at.set(l, base + 4 * n + NODE * i));
  }
  // The cell triggers of the variables routed, after the triggers, and then the stack's: eudplib's EUDVariable, 72
  // bytes each — a trigger whose conditions end at once, its action at +328 (destination +344, number +348), the next
  // action's kind 0. They overlap: what one trigger reads of its node is bytes the others never read (eudplib lays its
  // variables out so).
  const routes = [...routed];
  const graphs = runs.map((r) => r.graph);
  // (A region every run names — the heap's — is laid out once.)
  const regionList = [...new Map(graphs.flatMap((g) => g.cells ?? []).map((r) => [r.id, r])).values()];
  const cellCount = routes.length + regionList.reduce((n, r) => n + r.cells, 0);
  const cellBase = cellCount ? base + 4 * space.stack(Array.from({ length: cellCount }, (_, k) => CELL_HOLDS.map((d) => d + CELL_DWORDS * k)).flat(), space.top) : base;
  routes.forEach((id, k) => at.set(ROUTE_CELL + id, cellBase + 72 * k));
  const routeOf = (id: string) => at.get(ROUTE_CELL + id);
  const regions = new Map<string, number>();
  let cellTriggers = routes.length;
  for (const r of regionList) {
    regions.set(r.id, cellBase + 72 * cellTriggers);
    cellTriggers += r.cells;
  }
  const regionOf = (id: string) => regions.get(id);
  // The data in the gaps: the variables' cells, the graph's dwords; after everything, the lists it reads (each cell
  // `stride` EPD apart) and the templates.
  const cells = new Map<string, number>();
  const cell = (name: string) => {
    if (!cells.has(name)) cells.set(name, base + 4 * space.dword());
    return cells.get(name)!;
  };
  const lists = new Map<string, number>();
  const listData: { at: number; values: number[]; stride: number }[] = [];
  for (const a of graphs.flatMap((g) => g.arrays ?? [])) {
    const values = input.arrays.get(a.id);
    if (!values) throw new Error(`the graph reads ${a.id}, a list it was not given`);
    const l = base + 4 * space.run(a.stride * Math.max(1, values.length) + 1);
    lists.set(a.id, l);
    listData.push({ at: l, values, stride: a.stride });
  }
  // The templates of texts printed with values, each on a dword's start (where the map maker put them, or here).
  const templates = new Map<string, number>(input.templateAt ?? []);
  for (const t of graphs.flatMap((g) => g.templates ?? [])) {
    if (t.at !== undefined) templates.set(t.id, t.at);
    if (templates.has(t.id)) continue;
    templates.set(t.id, base + 4 * space.run(Math.ceil(t.bytes.length / 4)));
  }
  const field = (d: Extract<Dword, { at: string }>): number => {
    const t = at.get(d.at);
    if (t === undefined) throw new Error(`no trigger ${d.at}`);
    const f = d.field;
    if (f === "next") return t + 4;
    if (f === "current") return t + 2404;
    if (f === "flags") return t + 2376;
    if ("cond" in f) return t + 8 + 20 * f.cond + (f.part === "player" ? 4 : f.part === "mask" ? 0 : 8);
    return t + 328 + 32 * f.act + { value: 20, dest: 16, modifier: 24, mask: 0, text: 4, wav: 8, time: 12, flags: 28 }[f.part];
  };
  const address = (d: Dword): number => {
    if ("game" in d) return d.game;
    if ("var" in d) return routeOf(d.var) !== undefined ? routeOf(d.var)! + 348 : cell(`var:${d.var}`);
    if ("data" in d && d.data.startsWith(ROUTE_DEST)) return routeOf(d.data.slice(ROUTE_DEST.length))! + 344;
    if ("data" in d && d.data.startsWith(ROUTE_NEXT)) return routeOf(d.data.slice(ROUTE_NEXT.length))! + 4;
    // (The fields of its run's `@wake` a sleep writes: the tick its condition compares the game's with, where it goes,
    // its next.)
    if ("data" in d) {
      const [name, i] = d.data.split("#");
      const w = name === WAKE_TICK ? 8 + 8 : name === WAKE_AT ? 328 + 20 : name === WAKE_NEXT ? 4 : undefined;
      if (w !== undefined) return at.get(wake(Number(i ?? 0)))! + w;
    }
    if ("data" in d) return cell(`data:${d.data}`);
    // (A scratch cell of the graph's is the cell of a variable named after it, as the copy from it says.)
    if ("temp" in d) return address({ var: `@${d.temp}` });
    if ("element" in d && regionOf(d.element) !== undefined) return regionOf(d.element)! + 348;
    if ("cell" in d) {
      const r = regionOf(d.cell);
      if (r === undefined) throw new Error(`no region ${d.cell}`);
      return r + 72 * d.index + 348;
    }
    if ("template" in d) {
      const t = templates.get(d.template);
      if (t === undefined) throw new Error(`no template ${d.template}`);
      return t + 4 * d.word;
    }
    if ("element" in d) {
      const l = lists.get(d.element);
      if (l === undefined) throw new Error(`the graph reads ${d.element} without saying so`);
      return l;
    }
    if ("at" in d) return field(d);
    throw new Error("a parameter of a function of the Python side's has no place in a map of our own");
  };
  const value = (v: Value): number => {
    if (typeof v === "number") return u(v);
    if ("epd" in v) return epd(address(v.epd));
    if ("label" in v) {
      const t = at.get(endOf(v.label));
      if (t === undefined) throw new Error(`no trigger ${v.label}`);
      return t;
    }
    if ("addrOf" in v && regionOf(v.addrOf) !== undefined) return u(regionOf(v.addrOf)! + v.plus);
    if ("addrOf" in v) throw new Error(`a jump into ${v.addrOf}'s cells, which a map of our own does not lay out`);
    if (regionOf(v.epdOf) !== undefined) return u(epd(regionOf(v.epdOf)! + 348) + v.plus);
    const l = lists.get(v.epdOf);
    if (l === undefined) throw new Error(`no list ${v.epdOf}`);
    return u(epd(l) + v.plus);
  };
  // (Every address first: the cells are allocated as the triggers name them, so the size is known after.)
  const encoded = triggers.map((t) => ({
    t,
    conds: t.conds.map((c) => ({ c, player: c.game ? 0 : epd(address(c.dword)) })),
    acts: t.acts.map((a) => {
      const none = a.display !== undefined || a.show !== undefined || a.randomize !== undefined || a.record !== undefined;
      return { a, player: none ? 0 : epd(address(a.dword)), number: none ? 0 : value(a.value) };
    }),
  }));
  const size = 4 * space.top;
  const out = new Uint8Array(pad + size);
  const dv = new DataView(out.buffer);
  const w32 = (addr: number, v: number) => dv.setUint32(pad + addr - base, u(v), true);
  if (input.free) for (let i = 0; i < space.top; i++) if (!space.taken(i)) w32(base + 4 * i, input.free);
  encoded.forEach(({ t, conds, acts }) => {
    const n = at.get(t.label)!;
    if (t.prev !== undefined) w32(n, t.prev);
    w32(n + 4, typeof t.next === "number" ? t.next : at.get(t.next!)!);
    if (conds.length > 16 || acts.length > 64) throw new Error(`${t.label}: too many conditions or actions`);
    conds.forEach(({ c, player }, k) => {
      const o = n + 8 + 20 * k;
      if (c.game) {
        // A condition of the game's, as the script wrote it.
        const r = c.game;
        w32(o, r.location);
        w32(o + 4, r.player);
        w32(o + 8, r.amount);
        dv.setUint16(pad + o + 12 - base, r.unitId, true);
        for (const [at, b] of [[14, r.comparison], [15, r.type], [16, r.resource], [17, r.flags]]) dv.setUint8(pad + o + at - base, b);
        dv.setUint16(pad + o + 18 - base, r.mask, true);
        return;
      }
      w32(o, c.mask ?? 0);
      w32(o + 4, player);
      w32(o + 8, c.value);
      dv.setUint8(pad + o + 14 - base, COMPARE[c.compare]);
      dv.setUint8(pad + o + 15 - base, 15);
      if (c.mask !== undefined) dv.setUint16(pad + o + 18 - base, MASKED, true);
    });
    acts.forEach(({ a, player, number }, k) => {
      const o = n + 328 + 32 * k;
      if (a.record) {
        // An action of the game's, as the script wrote it: its text and its sound file put among the map's strings.
        const r = a.record;
        const str = (s: ScriptString | undefined, k: number) => {
          if (!k) return 0;
          if (!s) throw new Error(`${t.label}: an action's string ${k} with no text given for it`);
          return "index" in s ? s.index : input.text(s.text);
        };
        w32(o, r.location);
        if (a.textOf !== undefined && !input.template) throw new Error(`an action's text (${a.textOf}) with no string to show it by`);
        w32(o + 4, a.textOf !== undefined ? input.template!(a.textOf) : str(a.strings?.text, r.text));
        w32(o + 8, str(a.strings?.wav, r.wav));
        w32(o + 12, r.time);
        w32(o + 16, r.player);
        w32(o + 20, a.amountText ? u(input.text(a.amountText.text) * 2 ** a.amountText.shift) : r.target);
        dv.setUint16(pad + o + 24 - base, r.unitId, true);
        for (const [at, b] of [[26, r.type], [27, r.modifier], [28, r.flags], [29, r.padding]]) dv.setUint8(pad + o + at - base, b);
        dv.setUint16(pad + o + 30 - base, r.mask, true);
        return;
      }
      if (a.randomize !== undefined) {
        // Set Switch (13), its switch in the record's number, Randomize (11).
        w32(o + 20, a.randomize);
        dv.setUint8(pad + o + 26 - base, 13);
        dv.setUint8(pad + o + 27 - base, 11);
        dv.setUint8(pad + o + 28 - base, 4);
        return;
      }
      if (a.display !== undefined || a.show !== undefined) {
        if (a.show !== undefined && !input.template) throw new Error(`a printed text (${a.show}) with no string to show it by`);
        w32(o + 4, a.show !== undefined ? input.template!(a.show) : input.text(a.display!));
        dv.setUint8(pad + o + 26 - base, 9);
        dv.setUint8(pad + o + 28 - base, 4);
        return;
      }
      w32(o, a.mask ?? 0);
      w32(o + 16, player);
      w32(o + 20, number);
      dv.setUint8(pad + o + 26 - base, 45);
      dv.setUint8(pad + o + 27 - base, MODIFIER[a.modifier]);
      dv.setUint8(pad + o + 28 - base, 20);
      if (a.mask !== undefined) dv.setUint16(pad + o + 30 - base, MASKED, true);
    });
    // (Preserved — and done, one passed by; a trigger of the map's own with its flags as written.)
    w32(n + 2376, t.flags ?? (t.off ? TRIGGER_OFF : TRIGGER_ON));
  });
  for (const l of listData) l.values.forEach((v, i) => w32(l.at + 4 * l.stride * i, v));
  for (const t of graphs.flatMap((g) => g.templates ?? [])) if (!input.templateAt?.has(t.id) && t.at === undefined) t.bytes.forEach((b, i) => dv.setUint8(pad + templates.get(t.id)! + i - base, b));
  // What a region's cells hold when the map starts.
  for (const r of regionList) r.values?.forEach((v, i) => w32(regions.get(r.id)! + 72 * i + 348, v));
  // Each cell trigger: Set Deaths, add (its destination and next pointer written by every routing), preserved.
  for (let k = 0; k < cellTriggers; k++) {
    const c = cellBase + 72 * k;
    dv.setUint8(pad + c + 328 + 26 - base, 45);
    dv.setUint8(pad + c + 328 + 27 - base, MODIFIER.add);
    dv.setUint8(pad + c + 328 + 28 - base, 20);
    w32(c + 2376, 4);
  }
  const vars = new Map<string, number>([...cells].filter(([k]) => k.startsWith("var:")).map(([k, a]) => [k.slice(4), a]));
  routes.forEach((id, k) => vars.set(id, cellBase + 72 * k + 348));
  return {
    payload: out, trig: startUp(players, (p) => at.get(entry(p))!), address: base, vars, templates, regions,
    lists: new Map([...lists].map(([id, l]) => [id, { at: l, stride: listData.find((d) => d.at === l)!.stride }])),
    triggers: new Map(triggers.map((t) => [t.label, at.get(t.label)!])),
    routeCells: routes.length, cellCount, cellBase,
  };
}

/**
 * The start-up, in the map's TRIG section (the game's own triggers): in each player's, their list's last node read a
 * bit at a time into the deaths of Player 12's unit 0 (a scratch dword), made the current player's EPD less the one of
 * its next pointer; then that next pointer set to the player's entry. Player 12's deaths go back to 0. The first and
 * the last trigger are each player's own; those between, every player's (the game copies a trigger into the list of
 * each player it is for, and walks one list after another).
 */
function startUp(players: number[], entry: (p: number) => number): Uint8Array {
  const records: Uint8Array[] = [];
  const SCRATCH = 11; // Player 12's deaths of unit 0
  const record = (owners: number[], conds: { player: number; compare: number; value: number; mask?: number }[], acts: { player: number; modifier: number; value: number }[]) => {
    const r = new Uint8Array(2400);
    const dv = new DataView(r.buffer);
    conds.forEach((c, k) => {
      const o = 20 * k;
      dv.setUint32(o, c.mask ?? 0, true);
      dv.setUint32(o + 4, c.player, true);
      dv.setUint32(o + 8, u(c.value), true);
      dv.setUint8(o + 14, c.compare);
      dv.setUint8(o + 15, 15);
      if (c.mask !== undefined) dv.setUint16(o + 18, MASKED, true);
    });
    acts.forEach((a, k) => {
      const o = 320 + 32 * k;
      dv.setUint32(o + 16, a.player, true);
      dv.setUint32(o + 20, u(a.value), true);
      dv.setUint8(o + 26, 45);
      dv.setUint8(o + 27, a.modifier);
      dv.setUint8(o + 28, 20);
    });
    for (const p of owners) r[2372 + p] = 1;
    records.push(r);
  };
  const CURRENT = 13; // the player field "current player"
  // Each player's list's last node, into the scratch dword.
  for (const p of players) record([p], [], [{ player: epd(CURRENT_PLAYER), modifier: 7, value: epd(TRIGGER_LISTS + 4 + 12 * p) }, { player: SCRATCH, modifier: 7, value: 0 }]);
  for (let e = 2; e < 32; e++) record(players, [{ player: CURRENT, compare: 0, value: 1, mask: 2 ** e }], [{ player: SCRATCH, modifier: 8, value: 2 ** e }]);
  // The current player: the EPD of that node's next pointer.
  record(players, [], [{ player: epd(CURRENT_PLAYER), modifier: 7, value: epd(4) }]);
  for (let e = 2; e < 32; e++) record(players, [{ player: SCRATCH, compare: 0, value: 1, mask: 2 ** e }], [{ player: epd(CURRENT_PLAYER), modifier: 8, value: 2 ** (e - 2) }]);
  // The player's entry after it; the scratch dword back to 0; the current player the player again — the game set it
  // when it started on the list, and the map's own triggers after the start-up (step 13) read it (a Wait takes the
  // current player's wait slot; Display Text shows to them).
  for (const p of players) record([p], [], [{ player: CURRENT, modifier: 7, value: entry(p) }, { player: SCRATCH, modifier: 7, value: 0 }, { player: epd(CURRENT_PLAYER), modifier: 7, value: p }]);
  const out = new Uint8Array(2400 * records.length);
  records.forEach((r, i) => out.set(r, 2400 * i));
  return out;
}
