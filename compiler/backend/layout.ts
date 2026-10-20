/**
 * A map of our own (TrigScript 4, the backend: our own layout and start-up). A graph (`graph.ts`) laid out as the
 * game's triggers at fixed addresses, and the few triggers of the map's own TRIG section that hand the game's trigger
 * walk to them — no eudplib, no Python.
 *
 * Remastered keeps a map's string section at 0x191943C8 (eudplib counts on it: `payload_offset` in its
 * `maprw/injector/payload_init.py`), so what is put after the strings is at an address known when the map is built:
 * the payload needs no relocation in the game. The start-up is eudplib's stage 1, as small as it goes: the owner's
 * last trigger node is found by reading the player's trigger list (0x51A284 + 12 × player, the last node) a bit at a
 * time, and that node's next pointer is set to the payload. From then on every trigger pass of that player walks on
 * into the payload, which ends at a next pointer of 0x80000000 (the walk stops at a pointer with its top bit set,
 * as the list's own end is). The start-up's triggers are not preserved: each runs once.
 *
 * In memory a trigger is a node: the previous and the next pointer, 16 conditions of 20 bytes, 64 actions of 32, the
 * flags (4: preserved) and 28 bytes of players. A condition or an action names a dword by its EPD (its distance from
 * the deaths table in dwords) in its player field; a mask goes in its first field, with 'SC' in its last.
 */
import { END, isStack, type Act, type Cond, type Dword, type Graph, type Value } from "./graph";
import { GAME_TICK, WAKE_AT, WAKE_NEXT, WAKE_TICK } from "./emit";

export const STRINGS = 0x191943c8;
const DEATHS = 0x58a364;
const CURRENT_PLAYER = 0x6509b0;
const TRIGGER_WAIT = 0x6509a0;
const TRIGGER_LISTS = 0x51a280; // a player's list: 12 bytes, +4 its last node, +8 its first
const MASKED = 0x4353; // 'SC'
const NODE = 2408;
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
}

export interface LayoutInput {
  graph: Graph;
  /** The byte length of the string section the payload follows. */
  strings: number;
  /** The program's player, 0-based. */
  owner: number;
  /** A text's index in the map's string table (1-based), for Display Text. */
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
}

/**
 * The dwords of a variable's cell trigger (below) a routing writes — its action's destination, where it goes after —
 * and the label the walk is sent to it by.
 */
const ROUTE_DEST = "@route.dest:", ROUTE_NEXT = "@route.next:", ROUTE_CELL = "@route:";

/**
 * A graph's copies made of triggers: there is no Python side to route a variable's cell, so the layout routes it as
 * eudplib does. A variable that is copied keeps its value in the number of the one action of a trigger of its own —
 * Set Deaths, add — and a copy into a place is a trigger that sets the place to its constant, points that action at
 * the place and its trigger back here, and goes to it: the value added in, about 50 ns a place. A place that holds a
 * multiple of the variable other than 1 is filled a bit at a time instead: set to its constant, then one trigger a bit
 * of the cell adding that bit times the multiple (about half a microsecond a copy). Returns the variables routed.
 */
function expandCopies(graph: Graph): { graph: Graph; routed: Set<string> } {
  const out: Graph["triggers"] = [];
  const routed = new Set<string>();
  graph.triggers.forEach((t, i) => {
    if (!t.copy) { out.push(t); return; }
    const id = t.copy.from;
    const from: Dword = { var: id };
    const plain = t.copy.into.filter((p) => (p.scale ?? 1) === 1), scaled = t.copy.into.filter((p) => (p.scale ?? 1) !== 1);
    const after = graph.triggers[i + 1]?.label ?? END;
    const route = (j: number) => (j === 0 ? t.label : `${t.label}.route${j}`);
    const bits = (k: number) => (k === 0 && !plain.length ? t.label : `${t.label}.clear${k}`);
    if (!plain.length && !scaled.length) out.push({ label: t.label, conds: [], acts: [] });
    if (plain.length) routed.add(id);
    plain.forEach((p, j) => out.push({
      label: route(j),
      conds: [],
      acts: [
        { dword: p.dword, modifier: "set", value: p.add },
        { dword: { data: ROUTE_DEST + id }, modifier: "set", value: { epd: p.dword } },
        { dword: { data: ROUTE_NEXT + id }, modifier: "set", value: { label: j + 1 < plain.length ? route(j + 1) : scaled.length ? bits(0) : after } },
      ],
      next: ROUTE_CELL + id,
    }));
    if (!scaled.length) return;
    const chunks = <X,>(xs: X[]) => Array.from({ length: Math.ceil(xs.length / 64) || 1 }, (_, k) => xs.slice(64 * k, 64 * k + 64));
    chunks(scaled).forEach((part, k) => out.push({ label: bits(k), conds: [], acts: part.map((p) => ({ dword: p.dword, modifier: "set", value: p.add })) }));
    for (let bit = 0; bit < 32; bit++) chunks(scaled).forEach((part, k) => out.push({
      label: `${t.label}.bit${bit}.${k}`,
      conds: [{ dword: from, compare: "atLeast", value: 1, mask: 2 ** bit }],
      acts: part.map((p) => ({ dword: p.dword, modifier: "add", value: u((p.scale ?? 1) * 2 ** bit) })),
    }));
    // (The last bit's trigger falls through to what follows the copy.)
  });
  return { graph: { ...graph, triggers: out }, routed };
}

export function layout(input: LayoutInput): OwnMap {
  const { owner } = input;
  const { graph, routed } = expandCopies(input.graph);
  const pad = -input.strings & 3;
  const base = STRINGS + input.strings + pad;
  // The payload's triggers. `@wake` heads the owner's trigger list every pass: when the game's tick has reached the
  // one the program sleeps until, it sends the walk where the program goes on (the start, the first time); otherwise
  // the pass ends there. `@init`, the first time: the owner's list made the payload alone — its first node `@wake`,
  // its last `@stop`, which ends at the list's own end (eudplib's runner is linked so) — and the current player the
  // owner. A sleep writes `@wake`'s tick and where to go on; the program's end, a tick never reached.
  const wake = "@wake", init = "@init", stop = "@stop";
  const list = TRIGGER_LISTS + 12 * owner;
  type T = { label: string; conds: Cond[]; acts: Act[]; next?: string | number; prev?: number };
  const triggers: T[] = [
    { label: wake, prev: list + 4, conds: [{ dword: { game: GAME_TICK }, compare: "atLeast", value: 0 }], acts: [{ dword: { at: wake, field: "next" }, modifier: "set", value: { label: init } }, { dword: { game: CURRENT_PLAYER }, modifier: "set", value: owner }], next: stop },
    { label: init, conds: [], acts: [{ dword: { data: WAKE_NEXT }, modifier: "set", value: { label: stop } }, { dword: { game: list + 8 }, modifier: "set", value: { label: wake } }, { dword: { game: list + 4 }, modifier: "set", value: { label: stop } }], next: graph.triggers[0]?.label ?? stop },
    ...graph.triggers.map((t, i) => ({ label: t.label, conds: t.conds, acts: t.acts, next: t.next === END ? stop : t.next ?? graph.triggers[i + 1]?.label ?? stop })),
    // (Every pass ends here: the game's wait before the next pass set to none, as eudplib's eudTurbo does, so the
    // triggers run every frame and not every few seconds.)
    { label: stop, conds: [], acts: [{ dword: { game: TRIGGER_WAIT }, modifier: "set", value: 0 }], next: u(~(list + 4)) },
  ];
  for (const t of graph.triggers) if (t.copy || t.island || t.call) throw new Error(`${t.label}: a copy, an island or a call has no place in a map of our own`);
  const at = new Map<string, number>(triggers.map((t, i) => [t.label, base + NODE * i]));
  // The cell triggers of the variables routed, after the triggers, and then the stack's: eudplib's EUDVariable, 72
  // bytes each — a trigger whose conditions end at once, its action at +328 (destination +344, number +348), the next
  // action's kind 0. They overlap: what one trigger reads of its node is bytes the others never read (eudplib lays its
  // variables out so).
  const cellBase = base + NODE * triggers.length;
  const routes = [...routed];
  routes.forEach((id, k) => at.set(ROUTE_CELL + id, cellBase + 72 * k));
  const routeOf = (id: string) => at.get(ROUTE_CELL + id);
  const stackBase = new Map<string, number>();
  let cellTriggers = routes.length;
  for (const st of graph.stacks ?? []) {
    stackBase.set(st.id, cellBase + 72 * cellTriggers);
    cellTriggers += st.cells;
  }
  const stackOf = (id: string) => {
    const b = stackBase.get(id);
    if (b === undefined) throw new Error(`no stack ${id}`);
    return b;
  };
  // The data after them: the variables' cells, the graph's dwords, the lists it reads (each cell `stride` EPD apart).
  let next = cellTriggers ? cellBase + 72 * cellTriggers + NODE : cellBase;
  const cells = new Map<string, number>();
  const cell = (name: string) => {
    if (!cells.has(name)) { cells.set(name, next); next += 4; }
    return cells.get(name)!;
  };
  const lists = new Map<string, number>();
  const listData: { at: number; values: number[]; stride: number }[] = [];
  for (const a of graph.arrays ?? []) {
    const values = input.arrays.get(a.id);
    if (!values) throw new Error(`the graph reads ${a.id}, a list it was not given`);
    lists.set(a.id, next);
    listData.push({ at: next, values, stride: a.stride });
    next += 4 * a.stride * Math.max(1, values.length) + 4;
  }
  // The templates of texts printed with values, each on a dword's start (where the map maker put them, or here).
  const templates = new Map<string, number>(input.templateAt ?? []);
  for (const t of graph.templates ?? []) {
    if (templates.has(t.id)) continue;
    templates.set(t.id, next);
    next += 4 * Math.ceil(t.bytes.length / 4);
  }
  const field = (d: Extract<Dword, { at: string }>): number => {
    const t = at.get(d.at);
    if (t === undefined) throw new Error(`no trigger ${d.at}`);
    const f = d.field;
    if (f === "next") return t + 4;
    if ("cond" in f) return t + 8 + 20 * f.cond + (f.part === "player" ? 4 : 8);
    return t + 328 + 32 * f.act + { value: 20, dest: 16, modifier: 24 }[f.part];
  };
  const address = (d: Dword): number => {
    if ("game" in d) return d.game;
    if ("var" in d) return routeOf(d.var) !== undefined ? routeOf(d.var)! + 348 : cell(`var:${d.var}`);
    if ("data" in d && d.data.startsWith(ROUTE_DEST)) return routeOf(d.data.slice(ROUTE_DEST.length))! + 344;
    if ("data" in d && d.data.startsWith(ROUTE_NEXT)) return routeOf(d.data.slice(ROUTE_NEXT.length))! + 4;
    // (The fields of `@wake` a sleep writes: the tick its condition compares the game's with, where it goes, its next.)
    if ("data" in d && d.data === WAKE_TICK) return at.get(wake)! + 8 + 8;
    if ("data" in d && d.data === WAKE_AT) return at.get(wake)! + 328 + 20;
    if ("data" in d && d.data === WAKE_NEXT) return at.get(wake)! + 4;
    if ("data" in d) return cell(`data:${d.data}`);
    // (A scratch cell of the graph's is the cell of a variable named after it, as the copy from it says.)
    if ("temp" in d) return address({ var: `@${d.temp}` });
    if ("element" in d && isStack(d.element)) return stackOf(d.element) + 348;
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
      const t = at.get(v.label === END ? stop : v.label);
      if (t === undefined) throw new Error(`no trigger ${v.label}`);
      return t;
    }
    if ("addrOf" in v && isStack(v.addrOf)) return u(stackOf(v.addrOf) + v.plus);
    if ("addrOf" in v) throw new Error(`a jump into ${v.addrOf}'s cells, which a map of our own does not lay out`);
    if (isStack(v.epdOf)) return u(epd(stackOf(v.epdOf) + 348) + v.plus);
    const l = lists.get(v.epdOf);
    if (l === undefined) throw new Error(`no list ${v.epdOf}`);
    return u(epd(l) + v.plus);
  };
  // (Every address first: the cells are allocated as the triggers name them, so the size is known after.)
  const encoded = triggers.map((t) => ({
    t,
    conds: t.conds.map((c) => ({ c, player: epd(address(c.dword)) })),
    acts: t.acts.map((a) => ({ a, player: a.display !== undefined || a.show !== undefined ? 0 : epd(address(a.dword)), number: a.display !== undefined || a.show !== undefined ? 0 : value(a.value) })),
  }));
  const size = next - base;
  const out = new Uint8Array(pad + size);
  const dv = new DataView(out.buffer);
  const w32 = (addr: number, v: number) => dv.setUint32(pad + addr - base, u(v), true);
  encoded.forEach(({ t, conds, acts }) => {
    const n = at.get(t.label)!;
    if (t.prev !== undefined) w32(n, t.prev);
    w32(n + 4, typeof t.next === "number" ? t.next : at.get(t.next!)!);
    if (conds.length > 16 || acts.length > 64) throw new Error(`${t.label}: too many conditions or actions`);
    conds.forEach(({ c, player }, k) => {
      const o = n + 8 + 20 * k;
      w32(o, c.mask ?? 0);
      w32(o + 4, player);
      w32(o + 8, c.value);
      dv.setUint8(pad + o + 14 - base, COMPARE[c.compare]);
      dv.setUint8(pad + o + 15 - base, 15);
      if (c.mask !== undefined) dv.setUint16(pad + o + 18 - base, MASKED, true);
    });
    acts.forEach(({ a, player, number }, k) => {
      const o = n + 328 + 32 * k;
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
    w32(n + 2376, 4); // preserved
  });
  for (const l of listData) l.values.forEach((v, i) => w32(l.at + 4 * l.stride * i, v));
  for (const t of graph.templates ?? []) if (!input.templateAt?.has(t.id)) t.bytes.forEach((b, i) => dv.setUint8(pad + templates.get(t.id)! + i - base, b));
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
  return { payload: out, trig: startUp(owner, base), address: base, vars, templates };
}

/**
 * The start-up, in the map's TRIG section (the game's own triggers, for the owner): the owner's last trigger node,
 * read a bit at a time into the deaths of Player 12's unit 0 (a scratch dword), made the current player's EPD less
 * the one of its next pointer; then that next pointer set to the payload. Player 12's deaths go back to 0.
 */
function startUp(owner: number, payload: number): Uint8Array {
  const records: Uint8Array[] = [];
  const SCRATCH = 11; // Player 12's deaths of unit 0
  const record = (conds: { player: number; compare: number; value: number; mask?: number }[], acts: { player: number; modifier: number; value: number }[]) => {
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
    r[2372 + owner] = 1; // the owner's
    records.push(r);
  };
  const CURRENT = 13; // the player field "current player"
  // The list's last node, into the scratch dword.
  record([], [{ player: epd(CURRENT_PLAYER), modifier: 7, value: epd(TRIGGER_LISTS + 4 + 12 * owner) }, { player: SCRATCH, modifier: 7, value: 0 }]);
  for (let e = 2; e < 32; e++) record([{ player: CURRENT, compare: 0, value: 1, mask: 2 ** e }], [{ player: SCRATCH, modifier: 8, value: 2 ** e }]);
  // The current player: the EPD of that node's next pointer.
  record([], [{ player: epd(CURRENT_PLAYER), modifier: 7, value: epd(4) }]);
  for (let e = 2; e < 32; e++) record([{ player: SCRATCH, compare: 0, value: 1, mask: 2 ** e }], [{ player: epd(CURRENT_PLAYER), modifier: 8, value: 2 ** (e - 2) }]);
  // The payload after it; the scratch dword back to 0.
  record([], [{ player: CURRENT, modifier: 7, value: payload }, { player: SCRATCH, modifier: 7, value: 0 }]);
  const out = new Uint8Array(2400 * records.length);
  records.forEach((r, i) => out.set(r, 2400 * i));
  return out;
}
