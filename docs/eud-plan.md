# TrigScript on the Remastered target — the plan

Written 2026-09-17; revised the same day when the build server was replaced by the
[eudplib plugin](https://github.com/scm-js/plugin-eudplib), which runs eudplib inside the
editor. Status: slice 0 built (`python/trigscript.py` lowers a hand-written IR,
`probes/spike.ts` since slice 1, into `fixtures/eud/spike-eud.scx`, which is ignored because it sits on a Blizzard map). **Played 2026-09-18, all pass**: the tick every second, ore by a constant, gas set from a variable, the per-player greeting after a sleep, and a unit created when the counter reached 5. The second play found the one bug so far: `EUDVariable(n)` is a load-time value, so a temporary built with it kept the last run's total (see `fresh()` in `python/trigscript.py`). The
question it answers: what does TrigScript become when eudplib can assemble its output,
and how do we get the best developer experience out of that.

> **Revised 2026-09-18, for TrigScript 3.0.** Two decisions changed the shape of this plan,
> and the sections below are to be read through them:
>
> 1. **Programs are Remastered only.** There is no Classic target for `program()` any more:
>    the death-counter backend, the target switch, cost hints and the parity suite are gone.
>    `trigger()` is untouched and plays on every version. Every "on the classic target…"
>    clause below is void, including *Reads on the classic target* and *The classic install
>    on the Remastered target* under Open decisions (the second is what forced the choice:
>    no limit could be lifted while every script also had to fit Classic).
> 2. **One file, built on save.** No `<name>-eud.scx` beside the map and no Build & Test.
>    The editor has build steps now (`api.document.buildSteps`); the eudplib plugin owns the
>    one eudplib step and TrigScript *contributes* its IR to it, so Save, Test Map and an
>    export write the built map, with the map as the user edits it kept inside the file and
>    given back on open. *Where the built map goes* under Open decisions is settled by this.
>
> Also settled in 3.0: the IR is version 2 (a program's text is written out in the IR and
> added to the built map by eudplib, never interned into the source map); a program's
> owners are honoured (All Players and forces resolved from the map's player settings,
> human and computer); `frames(n)` is the unit of `sleep`, `cycles(n)` its old name; the
> lowering's arithmetic was brought to the contract the simulator states (whole sums,
> exact comparisons, `abs` as a distance, a 0 divisor gives 0), and the simulator mirrors
> the lowering down to the 32-bit wrap. Slices 2–6 below stand as written.
>
> **Slice 2, as built (3.2.0, 2026-09-18).** Reads are the comparing conditions without
> their comparison and amount, plus the plainer names; a read means what its condition
> means, because where no table of the game is the value the lowering searches with the
> condition itself. Player facts as planned, with `races.` and `slots.` to compare against
> and `supply(p, of, race?)` as the top bar shows it. Text: `displayText` stays "for the
> current player"; `print(text, { to, position })` addresses anyone else, and its positions
> are the chat area and the centre line (`f_eprintln`); `name(p)` and `color(p)` are marks
> inside a string, so they survive a helper or a `+`, and only `displayText` / `print`
> take them. `random(n)`, seeded from the game, and `& | ^ << >>`. IR version 3. The probe
> is `probes/reads.ts`.
>
> **Revised 2026-09-18 (evening): the language before the tooling.** The order of what is
> left changed. `test()` and the debugger were next; they now come after four slices that
> make a program's language the TypeScript a person already writes — signed numbers,
> arrays and keyed tables, functions that are really called, recursion — because each of
> those changes what a debugger and a test's `sim` have to show (a call stack, an array,
> a number below zero), and because the examples of the last slice should be written in
> the language as it ends up. The cost is probes: slice 5 as planned needed none, and each
> of these has one to be played. See *The language slices* under Slices; the *Numbers* and
> *Arrays* paragraphs of the programming model below are superseded by it.
>
> **Revised 2026-09-19: a fifth language slice, 8½.** For the same reason the language went
> before the tooling: callbacks on arrays, destructuring and spread, classes, and a `Map`
> over any number are what a person writing TypeScript reaches for next, and each changes
> what the debugger shows and what the examples look like. It takes 3.9.0; `test()` and the
> debugger move to 3.10.0 and the examples to 3.11.0.
>
> **Revised 2026-09-19, later: strings join slice 8½.** The user asked whether a text could
> be kept in a variable, then for the whole of it — `` `Wave ${n}` `` stored, not only shown.
> "There are no string variables" was stricter than the game is: a text of the string table
> is a number, and a text made while the map is played is bytes in the heap slice 6 built.
> One type, `string`, no capacity to declare. See *Strings* in the slice.

> **Where it stands, 2026-09-19 (night): slice 8½ is built and played, and 3.9.0 is not
> shipped.** All six parts — the methods that take a function, patterns and spread, arrays
> inside things, texts, classes, a `Map` and a `Set` over any number — are on `main` of this
> repository *locally*: nothing is pushed, the version still says 3.8.0, `dist/` is not
> rebuilt, and scm-js still pins v3.8.0. Every probe of the slice was played by the user
> with every step as expected: `callbacks`, `inside`, `strings`, `classes` (played twice,
> the second time after an instance came to be made straight on its row) and `map` (400
> reads in one frame without a pause that could be seen). The IR went 11 → 14 over the
> slice: 12 for arrays inside things, 13 for texts, 14 for a text in the cells of a row;
> the map over any number needed none. 464 tests pass, the eudplib builds among them. Each
> part's *As built* under slice 8½ says what it became, what was found on the way and what
> was left out.
>
> What shipping 3.9.0 takes, when the user says so: the version in `package.json`,
> `plugin.json` and `version.ts`; `npm run build` for `dist/`; the commit, the tag `v3.9.0`
> and the push; then scm-js (the pin in its defaults, the vendored copy, the guide's
> TrigScript section — classes, texts, the map — and the catalogue note), the registry, and
> the assistant's prompt in ai-server, whose deploy to the VM has been owed since 0.9.1.
>
> What is owed to the language after it, none of it in the way of 3.9.0 (each is an error
> that says what to do instead): a text local to a function that calls itself, and a
> function that takes or returns a text becoming one that is called (part 4); `string[]` a
> program fills, a function that returns an instance, an instance variable given another
> (part 5); a text or a unit for a `Map`'s key, `[...m.keys()]` (part 6); fusing a chain's
> loops, `toSorted` and the rest (part 1); `f(...xs)` (part 2); `filter` / `sort` of an
> array of arrays (part 3). After 3.9.0 the order is unchanged: slice 9, `test()` and the
> debugger (3.10.0), then slice 10, the examples (3.11.0) — and the debugger now has a call
> stack, arrays, rows, texts, instances and maps to show, which is why it waited.

## What we are aiming for

TrigScript today is TypeScript that runs when you build, with `program()` bodies compiled
into a state machine of death counters. It is honest about its limits: `a = b` is 66
triggers, a condition cannot be compared against a variable, a loop runs one iteration per
trigger cycle, a text cannot contain a number, and a program cannot see a unit's hit points.

With eudplib generating the triggers, every one of those limits goes away. The aim is
that a map maker who knows TypeScript writes what they mean and it works:

```ts
program(() => {
  let gold = 0;
  const shop = locations.Shop;
  while (true) {
    for (const u of unitsAt(shop, { owner: CurrentPlayer, type: units.TerranMarine })) {
      if (u.hp < u.maxHp / 2) { u.hp = u.maxHp; gold -= 10; }
    }
    const m = chatted(CurrentPlayer, "-give {amount}");
    if (m) { gold += m.amount; displayText(`${name(CurrentPlayer)} now has ${gold} gold`); }
    if (minerals(CurrentPlayer) > 1000) victory();
    sleep(frames(1));
  }
}, { owner: AllPlayers });
```

Nothing in that example is legal today. Under the plan it is all ordinary TrigScript on the
Remastered target, costs nothing worth a hint, simulates in the editor, and builds to a
playable map in about a second.

## Principles

1. **It is TypeScript.** If a construct is valid TypeScript and has a sensible meaning in
   the game, it works. If it does not, the error says why and what to write instead. No
   new syntax, no annotations in comments, no framework of callbacks: a program is a
   function, a loop is a loop, a unit is an object with properties.
2. **One language, two targets.** *Classic* (what exists today, runs on every version of
   the game) and *Remastered* (EUD, through the eudplib plugin). The Remastered target removes
   limits; it never changes what a program that compiles on both targets does. The
   simulator proves that: the test suite runs every classic program on both and expects
   the same events.
3. **The lowering takes data, never code.** The plugin emits an intermediate
   representation (IR) as JSON; its own euddraft plugin, `python/trigscript.py`, lowers
   it with eudplib inside the eudplib plugin's worker. There is no epScript and no
   `eval`, so an error is always a node of the IR and maps to a line in Monaco; and the
   Python ships with the TrigScript plugin, so the two halves of the IR version are
   always the same build.
4. **Everything is testable without the game.** The simulator moves up from triggers to
   the IR, so it runs both targets, and `test()` blocks let a script check itself when it
   is built.
5. **Only verified game facts ship.** A read or write on the Remastered target is offered
   only after a probe map has shown it working in the game. Magenta's catalogue (68 of 73
   entries verified as of 0.3.5) is the starting inventory; anything new gets a probe first.
6. **Costs stay visible.** The classic target keeps its trigger counts. The Remastered
   target shows what still costs something: a loop over every unit each frame, a print.

## The programming model on the Remastered target

**A program is a coroutine the game runs every frame.** The body runs from where it left
off until it reaches a `sleep()` or the end; `sleep(frames(n))` parks it for n frames,
`sleep(seconds(n))` converts at the game's frame rate (the build always includes eudTurbo,
so triggers run every frame; ~24 a second at Fastest, no hyper triggers needed). A program
that ends restarts next frame only if its body is a loop, as today. Several programs run
side by side, each with its own state, as today.

**Loops run to completion within the frame** unless they sleep. `for (let i = 0; i < n;
i++)` with a variable bound runs all n iterations before the next statement, as it reads.
The one rule the compiler enforces: a `while (true)` (or a loop whose condition never
mentions a variable the body changes) must `sleep()` on every path around it, otherwise it
would never give the frame back and the game would freeze. The error says so and points at
the loop.

**`CurrentPlayer` and per-player programs** stay. Per-player variables become a 12-slot
array per variable instead of a death-table row; `shared()` stays one value.

**Numbers** keep the classic contract: 32-bit, an expression is the exact sum, stored
below zero as 0 and at 2³² or above wrapped; `u8`/`u16` saturate at their maximum. Under
EUD this costs a compare instead of a decomposition, and the same test programs prove the
rule on both targets. Signed integers are not in the plan (see Open decisions).

**Booleans** are variables holding 0 or 1. **Records** stay a variable per field.
**Arrays** are new: `let hp = [0, 0, 0]` or `let lives: u8[] = new Array(12).fill(3)`
becomes an EUDArray, indexed by a constant or a variable, `.length` known when you build.
Nested arrays and arrays of records are allowed when their shape is known when you build.

**Strings are values in text, not variables.** A template literal in `displayText` may
contain a number expression, `name(player)` and `color(player)`; that becomes a dynamic
print. A `let s = "…"` variable is an error that says text is printed, not stored.

## The library

The vocabulary grows in four directions. Every item below is typed in the generated
`.d.ts`, completes in Monaco, and is marked with the target it needs, so on the classic
target it does not appear at all and an import of it is an error naming the target.

### Reads: every quantity a condition tests is also a value

Overloads, so nothing new has to be learned. Two arguments is a read; four is a condition:

```ts
if (deaths(P1, units.TerranMarine, ">=", 10)) …   // a condition, as today
let lost = deaths(P1, units.TerranMarine);          // a read
let ore = minerals(P1);                             // also resources(P1, "ore")
let n = countUnits(P2, units.ZergZergling, locations.Pen);   // what bring() tests
let k = kills(P1, units.AnyUnit);
let t = countdown();                                // what countdownTimer() tests
let e = elapsed();
```

Plus player facts: `race(p)`, `slot(p)`, `isHuman(p)`, `hasLeft(p)`, `supply(p, "used" |
"max", race?)`. A read anywhere a number is expected: `if (minerals(P1) > gold * 2)`.

On the classic target a read is also possible, by the same decomposition as a variable
copy, and is offered there too with a cost hint (this is the follow-up 2.5.0 left owed).
Player facts and supply are Remastered only.

### Units on the map as objects

A `Unit` is a unit that exists in the game right now (a CUnit pointer underneath). The
entries of the `units.` table are `UnitType`s, and `u.type` gives one. (Until 3.3 the table's
entries were typed `Unit<n>`; the rename came with slice 3, not slice 1 as first planned, and
a script using the old name is told the new one.)

```ts
for (const u of unitsAt(locations.Pen, { owner: P2 })) u.hp = u.maxHp / 2;
const target = nearest(units.TerranMarine, locations.Beacon, { owner: P1 });
if (target) target.order("move", locations.Exit);
```

Properties, each a read and, where the game allows it, a write: `hp`, `maxHp`, `shields`,
`energy`, `owner`, `type`, `x`, `y`, `kills`, `order` (read; a written order goes through
`.order(kind, target)` so the box trick Magenta verified is applied), `hallucinated`
(read), `cloaked` (read only: writing the cloak flags showed nothing in the probe),
`stim`/`ensnare`/`plague`/`lockdown`/`maelstrom`/`irradiate` timers in frames, `cooldown`
(write locks it), `invincible`, `speed` is *not* offered (per-unit speed fields failed).
Methods: `order(kind, target)`, `give(player)`, `kill()`, `remove()`, `damage(n | {percent})`,
`heal(n | {percent})`, `moveBy(dx, dy)` is on locations, not units (a position write exits
the game with "EUD not supported"; the probe proved it).

Sources of units: `unitsAt(location, filter?)`, `unitsOf(player, filter?)`, `allUnits(filter?)`
(each a loop over the unit table, cost shown as a hint), `nearest(type, location, filter?)`,
`first(...)`, `randomUnit(...)`, `underMouse(player)`. A `Unit` variable can be
stored and tested for `null`; it is a pointer and the compiler re-checks it is still the
same unit before each use (the game reuses slots).

### The game's tables

Values that Magenta's probes verified as live writes, exposed as objects with writable
properties on a build-time table entry:

```ts
program(() => {
  stats(units.TerranMarine).minerals = 25;
  stats(units.TerranMarine).speed = 8;         // the four flingy records, as Magenta writes them
  stats(units.ZergZergling).name = "Dog";        // a map string
  stats(upgrades.InfantryArmor).minerals = 50;
  stats(units.TerranGhost).permanentCloak = true;
  stats(P3).color = "teal";                      // colour byte + minimap; the mapping write failed and is not offered
});
```

Only the fields the probes passed are declared; a field the game showed no effect for
(game speed, colour mapping, position, sprite tint, terrain) is left out on purpose, and
the note in Magenta's `docs/candidates.md` says why for each.

### Input

Synced input through the MSQC plugin and chat through chatEvent, both composed by the
compiler with no configuration:

```ts
const m = chatted(CurrentPlayer, "-spawn {n} {unit:name}");   // null or { n, unit } this frame
if (keyPressed(CurrentPlayer, "F2")) …                          // true on the frame the key went down
if (clicked(CurrentPlayer, "left")) { const at = mouse(CurrentPlayer); … }
const u = underMouse(CurrentPlayer);
```

`chatted()` patterns: `{name}` captures a number, `{name:unit}` a unit type by its
display name, `{name:word}` a word (compared against a constant list the pattern
declares). Literal text is exact. Chat needs exactly the regex shape chatEvent accepts;
the compiler builds it. The single-player chat caveat from the probes goes in the guide.

### Text

`displayText` takes a template literal with expressions, `name(p)`, `color(p)`, and the
existing colour codes; `print(text, { to: player, position?: "top" })` for the alternatives
eudplib offers. Text with variables becomes a dynamic print; text without stays a map
string, as today.

### Randomness and arithmetic

`random(n)` returns 0 … n−1 as a number; `random()` stays a boolean. `a / b`, `a % b`,
`a * b`, `&`, `|`, `^`, `<<`, `>>` between variables all work, each one call underneath;
`Math.min/max/abs/clamp` stay.

## The tooling

**The workspace (3.1).** Everything below lives in a frame laid out as VS Code is
(`shell.ts`): the Explorer with the files and the programs' variables, tabs with the run
controls at their right, a panel of views under the editor (Problems, Output, Simulate), a
status bar, notifications in the corner, and every command in Monaco's palette with VS
Code's keys. Nothing that appears moves the text. So where this plan says a *panel* — the
Tests panel, the Run panel, the world table — it means a view of that bottom panel (and,
once there are two things to switch between at the left, an activity bar over the
Explorer); where it says a *status line*, an item of the status bar; breakpoints are
Monaco's glyph margin, F5 starts what VS Code would start, and the debugger's controls are
a floating strip over the editor's top edge, as VS Code's are.

**Target switch.** A toolbar control, *Classic* / *Remastered (EUD)*, stored in
`build.json`. Switching regenerates the declarations, so completion shows only what the
target has; a script using Remastered names on the classic target gets one error per use
naming the target. The guide's first line about the Remastered target is that the built
map needs StarCraft: Remastered.

**Cost hints** keep their shape. Classic: trigger counts as today. Remastered: a label on
lines that iterate the unit table ("scans every unit each frame"), on prints, and on a
loop with no sleep on a path (an error, not a hint). The `program(` line shows the
payload's size in the map once the build has answered.

**Simulator on the IR.** `simulate.ts` becomes an interpreter of the IR rather than of
trigger records. It gains a small world model: units with the properties above, resources,
kills, a chat and key queue, the mouse, the frame counter. Classic programs go through the
same IR (the classic backend lowers the IR to triggers; the trigger interpreter stays for
`trigger()` records and for the classic backend's own tests). Unit conditions stop
answering "false": `bring()` counts the simulated units.

**`test()` blocks.** Ordinary TypeScript run when the script is built, against the
simulator, so a script checks itself:

```ts
test("the first wave spawns after the beacon", (sim) => {
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.frames(24);
  expect(sim.count(P2, units.ZergZergling, locations.Spawn)).toBe(6);
});
```

`sim` is the world (`place`, `type(player, text)`, `press`, `click`, `frames`, `seconds`,
`count`, `resources`, `text()`, `events`), `expect` is a small matcher set. Results show in a
Tests panel of the workspace with pass/fail and the failing line; Build warns on a failing
test, and a preference makes it refuse.

**Debugger.** The simulator steps: a Run panel with *Frame*, *Step*, *Run to breakpoint*,
the current line highlighted in Monaco, variables and the world in a side table,
breakpoints in the glyph margin. Works on both targets because it is the IR.

**Build & Test.** One button on the Remastered target: compile, hand the IR, the map and
`trigscript.py` to the eudplib plugin's `eudplib.build` service (the library asks to
download its runtime the first time, about 15 MB, once), save `<name>-eud.scx` beside
the map (the Save dialog's file handles), then what *Test Map* does with it. A widget
shows the steps and the build log; a build error lands on the IR node's line in Monaco. The source map keeps its source and its classic
triggers; the built map is an output, as Magenta's is. *Build* alone on this target
produces the same file without launching.

**Library status.** TrigScript's manifest `requires` the eudplib plugin, so installing
TrigScript installs it and it cannot be turned off underneath. The workspace's status line
shows whether the library is running and its eudplib version (from the service's
`versions`), and the Remastered target refuses to build with a plain message when it is not.

**Examples.** *New from example…* in the file list: wave defence, a shop with chat
commands, mouse-controlled hero, per-player lives, a stat rework — each a complete script
with a `test()` block, each also a fixture in the test suite so they never rot. The guide
grows a "Remastered target" section built from them.

**The assistant.** The compact declarations carry the new vocabulary with the target, and
*Write Triggers* asks the state for the target, so the AI writes for the one the map is on.

## Architecture

### In the plugin

- `compiler/ir.ts`: the IR types. A `Program` is `{ owner, owners, perPlayer, variables,
  body }`; statements are `assign | if | while | for | switch | block | sleep | action |
  call | return | foreach | test`; expressions are `const | var | read | field | binary |
  unary | ternary | call | condition`; every node carries `at: { file, line, column }`.
  Versioned (`IR_VERSION`), documented in `docs/ir.md`, and the contract with `python/trigscript.py`.
- `structured.ts` emits IR instead of driving `Machine` directly. `lower.ts` (the classic
  backend) consumes IR: this is the one refactor with risk, done first and proven by the
  existing 137 tests running unchanged.
- `compiler/eud.ts`: the Remastered backend is a pass that checks the IR against the
  target (no unsupported reads on classic, sleep rule, string rule) and serialises it.
- `service.ts`: `build()` on the Remastered target calls the eudplib service; `BuildOptions.target`;
  the manifest gains `target` and `ir` version.
- `declarations.ts`: two flavours from one table, each entry tagged with its target; the
  brand `Unit<n>` becomes `UnitType<n>`, and `Unit` is the instance (declared on both
  targets; on classic nothing produces one and the compiler names the Remastered target).
- `simulate.ts`: rewritten over IR, with the world model; `tests/` gains the two-target
  parity suite.

### In `python/trigscript.py`

- The euddraft plugin, handed to the eudplib service as a `sources` entry with every
  build, the IR as a `files` entry (`/work/files/trigscript.json`, named by the plugin's
  `ir` setting). It reads the IR, checks `version`, lowers. Variables → `EUDVariable`
  (per-player → `EUDArray(12)` indexed by the current player); `if`/`while` →
  `EUDIf`/`EUDWhile` with variable-aware conditions; `sleep` → the state split (state
  variable + `EUDSwitch` per program, the same shape the classic backend uses; slice 0
  cuts the body at top-level sleeps, slice 1 lowers every block to jumps between labelled
  segments so a sleep may sit anywhere); actions with variables → eudplib actions taking
  `EUDVariable` fields; reads → `f_dwread_epd`/CUnit fields; `foreach` → `EUDLoopNewUnit`
  with the filter; chat and MSQC → the same composition Magenta uses (copied, the two
  plugins are independent repositories); prints → `f_simpleprint` with `PName`/`PColor`.
- Embedded into the bundle as a string (`scripts/embed-python.mts`, as Magenta does) with
  a test that fails on drift and pins the Python's `IR_VERSION` to the compiler's.
- Errors: the lowering raises with the offending node's `at`; the service rejects with
  the message, the plugin parses `at` out of it; unexpected eudplib exceptions carry the
  nearest node.
- Tests: `npm run build:map` in a plugin-eudplib checkout lowers fixture IRs under Node
  (the same worker the editor runs); a golden set of built maps checked for size and for
  the trigger count the bootstrap expects.

### What stays as it is

The run-at-build-time model, the hoist plan, the workspace, Import map triggers, the
stale block logic, the claim on the generated block, the commands other plugins use, the
classic target's numbers.

## Slices

Each slice ships as a tagged plugin version. Each has a probe map that gets played
before the slice is called done, in the Magenta manner.

| # | Slice | What it proves | Size |
| --- | --- | --- | --- |
| 0 | Spike: hand-written IR → eudplib plugin → map; a counter, a sleep, a dynamic print, per-player (built 2026-09-17, played 2026-09-18: all pass) | frames, eudTurbo, prints, per-player arrays work; a number for build time and payload size | 1 day |
| 1 | IR refactor + Remastered backend for today's language + Build & Test + simulator on IR | every existing test program simulates identically on both targets; `a = b` and `if (a < b)` cost nothing; loops run in-frame; the sleep rule | the big one, ~1 week |
| 1½ | The workspace as VS Code lays one out (3.1.0) | the frame slices 5 and 6 put their panels in: no banner moves the text, every command in the palette, the keys people already know | 2 days, no probe: nothing about the game changes |
| 2 | Reads and text (3.2.0) | `deaths(P1, u)` as a value, `minerals()`, `countUnits()`, player facts, template literals with numbers and names, `print()`, `random(n)`, the bitwise operators | 2–3 days |
| 3 | `Unit` objects, unit loops, picks, `stats()` (3.3.0; built 2026-09-18, the probe is `probes/units.ts`) | the Magenta-verified list as typed objects; the pointer re-check; hints for scans | 3–4 days |
| 4 | Input (3.4.0; built 2026-09-18, the probe is `probes/input.ts`) | `chatted()` with captures, `keyPressed`, `clicked`, `mouse`, `underMouse`; MSQC and chatEvent composed automatically | 2–3 days |
| 5 | Signed numbers (3.5.0; the probe is `probes/numbers.ts`, played 2026-09-18: every line as expected, the ore at 75 at the end) | `number` is a signed 32-bit integer, `u32` the unsigned one beside it, `>>>` apart from `>>`, division towards zero; IR 6 | 2–3 days |
| 6 | Arrays and keyed tables (3.6.0; the probe is `probes/arrays.ts`, played 2026-09-18: step L — 20 000 pushes at 500 a frame — did not stutter, said out of memory once and stopped at 4096, the push the simulator stops at; M found room again in the blocks given back, N had an array a player and one shared; played again 2026-09-19 with the records, the array of units and the Map loops — steps O to Q — all as expected) | `number[]`, `boolean[]`, arrays of records and of units, a variable index, `for…of`, `push` / `pop` on an array that grows out of a heap; `Record<K, V>`, `Map<K, V>` and `Set<K>` over a key set known when the script is built | 4–5 days |
| 7 | Functions that are called (3.7.0; the probe is `probes/functions.ts`, played 2026-09-19: every line as expected — 2000 calls in one frame without a stutter, one Marine at 10 hit points, the per-player line) | a function that never sleeps and whose parameters go only where a variable may go is one copy in the map, called from every site; the rest stay inlined; a hint says which; a function that takes an array is one copy an array passed; the simulator's faults shown in the Simulate view | 3 days |
| 8 | Recursion (3.8.0; the probe is `probes/recursion.ts`, played 2026-09-19: as expected — `fib(20)`, 21 891 calls in one frame, with basically no pause; the overflow said in red where the third program stopped and the first going on to its end) | a function on a cycle of the call graph saves its frame on a stack around the call; a depth limit that says so in the game and fails a test | 3–4 days |
| 8½ | The TypeScript people write (3.9.0; built 2026-09-19, not shipped; the probes are `probes/callbacks.ts`, `inside.ts`, `strings.ts`, `classes.ts` and `map.ts`, all played 2026-09-19 with every step as expected) | `forEach` / `map` / `filter` / `some` / `every` / `find` / `reduce` / `sort` with the arrow inlined into the loop; destructuring and spread; arrays inside records and arrays of arrays; `string` as a value — a text of the table as its id, a text that was made as bytes in the heap; a class as a record and its functions; `Map<number, V>` and `Set<number>` over any key | 10–11 days |
| 9 | `test()` blocks + debugger (3.10.0) | Tests panel, frame stepping, breakpoints, a call stack, arrays in the variables view, the world table | 3–4 days, no probe |
| 10 | Examples, guide, assistant prompts, registry (3.11.0) | the five examples as fixtures; README and the user guide's Remastered section; scmjs.dev's Write Triggers knows the whole language | 2 days, no probe |

**Slice 3 as built**, where it differs from the sections above: the read of a unit's order is
`orderId` (a property and a method cannot share the name `order`); `underMouse()` waits for
slice 4, which brings the mouse; `locate(location)`, `underAttack`, `stasis` and `resources`
were added from Magenta's verified list; a `sleep()` inside a loop over units is an error (the
unit table moves between frames — the way to act on one unit at a time is to find it again
after each sleep), which also means the unit of a loop's turn needs no re-check; `stats()` is
one function told apart by the brand of its argument's type, since a table's index is a plain
number when the script runs; `stats(player)` has `color`, `upgrades[…]` and `researched[…]`;
a value with a scale (`speed`, `buildTime`, `supplyUsed`) takes a fraction when it is known at
build time. The unit classes turned out to be one too low in the editor's table (Any unit 228
for 229, and so on); corrected there and here with this slice.

**Slice 4 as built** (3.4.0; the probe is `probes/input.ts`), where it differs from the
sections above. Nothing of the map's is used for the cells: chatEvent and MSQC take a *name*
wherever they take an address or a death-counter unit, so the lowering registers
`EUDArray(12)`s and `EUDVariable`s under names the compiler also writes into the two plugins'
settings (`compiler/input.ts`; Magenta uses death counters because its rows are conditions
of ordinary triggers — a program needs none). chatEvent is given no messages at all: it only
finds the local player's line, and `trigscript.py` matches every pattern itself, on the
computer the line was typed on, so there is one matcher, no two-`.*` rule and no clash
between patterns sharing a first word. chatEvent's result is local (it prints "desync"
beside it), so the pattern's number and its values go through MSQC's `val` to every
computer — which is why a typed number stops at 2²⁰ − 1 (what `val` carries on the smallest
map) and a pattern reads at most three values (one command unit per human each). A
`{name:unit}` capture is looked up by a hash of the lower-cased rest of the line in a
sorted table (a search by halves), a `{name:a|b}` capture the same way against its words.
`chatted()` gives a record of the program's numbers with a boolean of its own for `if (m)`;
`mouse()` a record of two. `mouse(p)` has no `locate()`: `centerLocation(location, x, y)`
is a statement of its own, useful with any two numbers. An action takes several fields from
the program at once, a unit type among them (`createUnit(p, m.what, m.n, at)`) — IR 5 has
`variables` where 4 had `variable`. The input functions refuse to run outside a program,
where a truthy object would make `if (keyPressed(…))` always true. An input never counts
as "moving" for the sleep rule: it cannot change within the frame. Locations come from the
map's first 63, highest first, which every map's table has. Found on the way: the lowering
waited one frame longer than every `sleep()` asked, so a loop sleeping a frame ran every
other frame and would have missed half the presses; fixed with this slice (the simulator
always had it right). What `test()` needs — `sim.press`, `sim.click`, `sim.type`,
`sim.moveMouse` — is in the interpreter already. The probe was played three times: everything
passed but F6, which the game never reports (silent first in MSQC's settings and silent
third, while F7, F8, `1`, Q, W and E answered), so F6 is not a `Key`. MSQC's unit type (the Valkyrie) and its
player (12) are fixed for now; a map that uses Valkyries has no way to say so yet.

### The language slices (5–8½)

Decided 2026-09-18 with the user. What they share: the source is TypeScript a person would
write anyway, and where the game cannot follow, the compiler says so at the line.

**5. Numbers (3.5.0).** Programs have been Remastered only since 3.0, so the reason a value
below zero was stored as 0 — parity with a death counter — is gone, and it was the least
TypeScript thing in the language.

| Type | Meaning |
| --- | --- |
| `number` | A signed 32-bit integer, −2 147 483 648 to 2 147 483 647, wrapping as `x \| 0` does. What everything is unless it says otherwise, and what every read of the game gives (`deaths()`, `minerals()`, `u.hp`). |
| `u32` | Unsigned, 0 to 4 294 967 295, wrapping as `x >>> 0` does. For bit masks, hashes, and a counter past two thousand million. |
| `u8`, `u16` | As they were: 0 to 255 / 65 535, stopping at either end when stored. |

- `+ − * & | ^ <<` are the same 32 bits whichever the type. The type decides five things: a
  comparison, `/` and `%` (towards zero for a `number`, as `Math.trunc(a / b)`; the remainder
  takes the dividend's sign, as in JavaScript), `>>` (keeps the sign of a `number`) against
  `>>>` (never does), `Math.min` / `Math.max`, and how a number is printed.
- **Mixing.** A whole-number constant that fits is either type. A `number` and a `u32` in one
  piece of arithmetic is a compile error that names `u32(x)` and `i32(x)`, which cost
  nothing; `x >>> 0` is `u32(x)`, as it is in JavaScript. A *comparison* between the two is
  not an error: it is computed exactly (a `number` below zero is smaller than any `u32`).
  Assigning one to a variable of the other keeps the bits, as the conversion functions do.
- **Where the game takes no number below zero** — a `u8` / `u16`, a unit's hit points, an
  action's amount, a cell of `stats()`, `random(n)`'s bound, a place on the map — a
  `number` below zero goes in as 0. The front end writes that as `max(v, 0)` where it cannot
  see that the value is never below zero (a read, a `u8`, `x & 0xff`, `x % n` of such), so
  the lowering's stores stay what they were.
- A signed comparison costs an addition a side (the top bit flipped); `==` and `!=` cost
  nothing extra, and neither does a comparison both of whose sides are never below zero.
- The one difference from a TypeScript `number` that is left: ours wraps at ±2³¹ where a
  double would go on. The README says so in a sentence; the simulator wraps the same way.
- IR 6: `VarDecl.unsigned`, the `>>>` operator, `unsigned` on `/` `%` `min` `max` and on a
  printed number, `unsigned: true | "left" | "right"` on a comparison. The flattening of `+`
  and `−` into two sides, which is how an unsigned cell was made to mean a difference, goes.

**6. Arrays and keyed tables (3.6.0).**

- `let hp = [0, 0, 0]`, `new Array(12).fill(3)`, `u8[]`, arrays of records (an array per
  field) and of units (three cells each, re-checked on use as a unit variable is). An index
  is a constant or a variable; `for…of`, `.length`, `indexOf`, `includes`, `fill` run within
  the frame. A per-player program has twelve of each, as it has of a variable.
- **An array that something pushes to grows** (decided 2026-09-18, when the user asked whether a declared capacity
  was "truly growable": it was not). `push`, `pop`, `length =`, `xs[xs.length] = v` make an array a handle on a block
  of a **heap** the programs share — 16 384 cells unless the map's script settings say otherwise (the workspace's
  Settings view; kept in the map, since the built map depends on it) — handed out in powers of two, a full block
  exchanged for one twice the size, a block given back kept for the next array of that size. A declaration first gives
  back what its handle held, so there is no collector and nothing to leak but one block a declaration. Out of memory:
  nothing is pushed, the game says so once, the simulator — which counts blocks as the game does — records a fault at
  the same push. (As first built the heap's top was the **stack**'s, growing down, for slice 8's saved frames;
  slice 8 gave the stack an array of its own instead — see there.) Locals stay cells of
  their own, because a condition or an action reaches a cell directly and a frame would make every access a read
  through a pointer. A read past the end is 0 and a write past it does nothing — in the game; the simulator says
  where, since it is always a mistake.
- **Keyed tables** (as built: keys are the library's branded ids — unit type, player, location, switch, weapon,
  upgrade, technology; a union of string literals is a record already, and a range of numbers an array).
  `Record<K, V>`, `Map<K, V>` and `Set<K>` are an array indexed by the key, so `price[u.type]` or
  `kills.get(CurrentPlayer)` with a key of the game is one read. `get`, `set`, `has`,
  `delete`, `clear`, `size` and `for…of` over the keys. `let s = {}` with fields added later
  is refused by TypeScript itself; its typed form, `Record<K, V>`, is this.
- A `Map<number, number>` over *any* key is a hash table, a few probes an operation. Not
  in this slice: it is the last part of slice 8½. A key that is a string of the
  game does not exist: there are no strings when the map is played (as of 3.6 — slice 8½'s
  *Strings* changes that, though not for a key).
- Left out of 3.6, and where each went (2026-09-19): an array inside a record and an array
  of arrays are a part of slice 8½, before the classes that need them; the simulator's
  faults shown in the Simulate view come with slice 7; arrays in the Explorer and the
  variables view are slice 9's, with the debugger that draws them anyway.

**7. Functions that are called (3.7.0).** Inlining stays the default because two things
need it: a function that sleeps (the program resumes inside it, through the lowering's own
jumps), and a parameter that reaches a field only a value known at build time can fill
(`spawn(P2, 4)`'s player). A function with neither, called from more than one place, becomes
one copy that is called; the source is the same either way and the end of the line says
which, as *unrolled ×3* does. What it buys is the size of the built map.

An array parameter stays what it is in 3.6, a name for the caller's array settled when the
script is built — so a function that takes one is called as one copy *an array passed*, the
way a template is: `total(hp)` and `total(shields)` are two copies, five calls of
`total(hp)` one. No array is reached through a value of the game in this slice (that comes
with slice 8½'s arrays inside things), and slice 8's `fill(grid, x, y)` recurses on the
same terms. The hint counts the copies.

**As built.** The decision is made while the body is walked, not before: a function is
inlined where it is first met — exactly as 3.6 did it, so a function used once builds into
what it always did — and when it is met again (at the same arrays) the compiler tries it as
a called function, every parameter a variable, and throws the attempt away with its
diagnostics if it sleeps, holds a `rose()` / `once()` or does not compile that way. When
the attempt holds, the first call is changed to match. After the walk, a function left
with one call that is still part of the program (the others were in a body that was thrown
away) is inlined there again. "More than one place" counts calls as they are emitted, so a
call in a loop unrolled three times is three. Only functions declared at the top of a
program's body, and `game()` functions, are called; one declared inside a block may use
that block's variables and stays inlined. IR 10: `Program.functions`, `Call.fn`. The
lowering makes each an `EUDFunc` of no arguments — parameters and results are cells of the
program, a row a player, so nothing of eudplib's own argument passing is used, which is
also what slice 8 needs to save a frame. Measured on ten calls of a fifteen-statement
function: 735 objects for 1462, a built map of 53 KB for 81 KB. Also with it: an array
written empty is one that grows, whoever pushes to it.

With it, the small thing 3.6 left: the simulator has recorded its **faults** since arrays
came — a read or a store past an end, a push that found no memory — and shows them nowhere.
The Simulate view lists them with their lines, and slice 8's stack overflow joins the same
list.

**8. Recursion (3.8.0).** A called function's parameters, result and locals are cells of
the program (slice 7 as built: an `EUDFunc` of no arguments, so none of eudplib's `_fargs` /
`_frets` are in play), and eudplib keeps one return address a function (`_nptr`) — so a call
from inside itself overwrites the outer one's cells and its way back. Slice 7 refused such a
call ("recursion is not possible") and never made a function on a cycle a called
one; this slice is what lifted that. A function on a cycle of the call graph — only
those pay — pushes its parameters, locals, live temporaries and return address on one stack
array around the call and pops them after; mutual recursion is the same. `fib`, a flood
fill over an array, a walk of a tree of indices compile as written. Three rules show that
it is not a JavaScript engine: no `sleep()` in such a function (which is also why one stack
serves every player — it is empty between frames); a depth limit, with a line in the game
("stack overflow in fill, line 12"), the program stopped, and the same as a failed test in
the simulator; and its parameters are variables, so one that reaches a build-time-only
field is a compile error. Cost: a store and a load a saved cell a call — fine in the tens
and hundreds, slow for thousands of calls in a frame; the probe times it.

**As built (2026-09-19).** Two things were decided with the user before building, both for
the sake of a limit that means the same every time. **The limit is a depth, not a size**:
the panel's Settings has *Recursion depth* beside the heap's size — 1 024 calls unless the
map says otherwise, 16 to 65 536, kept in the map and carried in the IR file as `stack` —
because a count of cells moves whenever a function gains a local, and "1 024 calls deep"
is what the message in the game can say. **The stack is an array of its own**, not the top
of the heap as slice 6 left it: sharing the pool made an overflow depend on what the arrays
held at that moment, so the same recursion could pass in Simulate and fail in the game, or
fail in one frame and not the next. It is as many frames of the script's largest frame as
the depth allows, there only when something recurses (Settings says what that comes to, and
a build refuses more than a million cells); `reserve` / `release` went from the heap.

The rest is `compiler/recursion.ts` and *Recursion* in `docs/ir.md`. The front end makes a
function a called one the moment it meets it inside itself — no second call from outside is
needed — and says why when it cannot (it sleeps; a parameter reaches a build-time-only
field), where 3.7 only said the copies nest too deeply. The pass finds the cycles, takes
every call that may come back out of the expression it is in — a backend's temporaries are
in no frame — turning `?:`, `&&`, `||` and loop conditions that hold one into the `if`s they
mean, and writes on each what to keep: everything of the function's but the call's own
result. Liveness was left out on purpose: a frame is three or four cells for the functions
people write, and a wrong "dead" is a wrong number in the game. Arrays declared in a
recursive function become growing ones, so a frame keeps a handle and not the cells. The
lowering could not use `EUDFunc` (one return address, and not callable until its body is
whole): a recursive function is a scope of triggers ended by one whose next-trigger field
is the return address. The interpreter runs such a body apart from its caller, since a
thousand calls deep was ten thousand frames of JavaScript's stack and ended the browser's
before the map's. Refused: such a call inside a loop over units, and a function that calls
itself on every path. Along the way: a parameter given a plain value may be assigned in the
function, and `c ? 1 : 0` is a number. What the probe had to say was step J — `fib(20)`,
21 891 calls in one frame — since a frame brought back is some thirty triggers a cell.
Played 2026-09-19: basically no pause. So the stack stays the plain array it is; had it
been slow, it could have become variable triggers chained frame by frame, which brings a
frame back in a trigger a cell, and that is where to start if a script ever needs more.

**8½. The TypeScript people write (3.9.0).** Added 2026-09-19. As 3.6 stands, an array of a
program has `push`, `pop`, `fill`, `includes`, `indexOf`, `length` and `for…of`, and says so
when anything else is called; a spread inside an array literal is refused; the only
destructuring is `for (const [k, v] of m.entries())`; a class is fine outside `program()`,
where the script simply runs, and nothing inside it; a text is shown and never kept. Six
parts, in this order, each of which can ship alone (but the classes want the arrays inside
things and the strings first):

- **Callbacks on arrays.** `forEach`, `some`, `every`, `find`, `findIndex`, `findLast`,
  `reduce`, `map`, `filter`, `sort` and `reverse`. The arrow — or the
  name of a function — is known when the script is built, so it is inlined into a loop over
  the cells, the way `includes` and `indexOf` already are functions of the compiler's own. A
  variable the arrow uses from outside is a cell of the program, so capturing costs nothing
  and there is no closure when the map is played. What that rules out is a function as a
  *value*: kept in a variable of the game, put in an array, returned. That is an error at the
  line, which says the arrow has to be written where it is used. `map` gives an array of the
  source's length (fixed if the source is, from the heap if not); `filter` always gives one
  that grows. `sort` wants its comparator — without one JavaScript sorts numbers as text,
  which nobody means, so the error names `(a, b) => a - b` — and is an insertion sort within
  the frame, with a hint over a few hundred cells. No `sleep()` in a callback; the message
  names `for…of`. A chain (`xs.filter(f).map(g)`) makes the array in the middle as written;
  fusing the two loops is for later, if a probe says it matters. The unit sets (`unitsOf(…)`
  and the rest) take `forEach`, `some`, `every`, `find` and `filter` the same way, since
  they are loops already.
  **As built (2026-09-19; probe played the same day, every step as expected).** Step J —
  256 cells the wrong way round, some 32 000 turns of the inner loop in one frame —
  stuttered "for an instant, maybe two frames": the insertion sort stays, and the hint's
  "hundreds every frame will be felt" is the right size of warning. `compiler/structured.ts`, *Methods that take a
  function*: `loopOver` is the loop (a list of the program, the units of the game as the
  loop over units, a list the script has unrolled), `callback` the function inlined with
  its parameters bound to the item, its place and the list, and the methods are those two.
  What gives a value — `some`, `every`, `find*`, `reduce` — is a function of the
  compiler's own with the loop inside it, as `includes` is, so it is worked out again
  wherever it stands, a loop's condition included; what makes an array emits its
  statements where it stands, which is why a loop's condition refuses it. The IR did not
  change (a `for` may carry `sorts`, for the hint; a lowering takes no notice), and the
  Python needed nothing. Four things were not in the plan:
  - the hoisting pass had to learn the function: its parameters and its `let`s are the
    game's, its body is planned as a declared function's is, and a `const` list that only
    such a function pushes to is found to be the program's after it was planned as the
    script's — so the plan is made again knowing it (`planProgram` loops until nothing
    new is forced; the set only grows);
  - `waves.forEach((w) => createUnit(…))` over a list of the script, with nothing of the
    program in it, was hoisted whole and ran when the script was built: actions nobody
    received, no diagnostic, in 3.8 too. A `forEach` whose function calls the library is
    now the program's, unrolled. `map` and the rest of a script's list stay the script's
    when nothing of the program is in them;
  - `find` of numbers: `undefined` does not exist when the map is played, so it is
    `xs.find(…) ?? value`, and bare it is an error that says so and names `findIndex`; of
    records the error names `findIndex` and `waves[i]`; of units it is a unit or none;
  - `new Array(12)` is `any[]` to TypeScript, and `any` went through `map` and `reduce`
    into variables that then had no kind. The declarations make it `number[]` unless it
    says otherwise (`new Array<boolean>(12)`). The library moved to ES2023 for `findLast`.
  Also: the check for a loop whose condition never changes read nothing out of a call in
  the condition (`while (f(x) > 0)` with `x--` inside was refused; so was `while
  (xs.some(…))`), and now reads what the call is handed and what its body reads. Left
  for later: fusing a chain's loops; `toSorted` / `toReversed` / `slice` / `concat`
  (ES2023 brought the first two into completion; they are refused by name); a method's
  result as `map`'s element when it is a unit or a record; Simulate stops a frame at
  100 000 statements, which a sort of 256 cells in no order passes. Probe
  `probes/callbacks.ts`, steps A–K; J is the 256-cell sort, timed by eye.
- **Destructuring and spread.** `const { x, y } = mouse(p)`, `const [a, b] = pair`, in a
  parameter, with defaults, nested, and `[a, b] = [b, a]` through temporaries. `[...xs, v]`
  and `{ ...r, hp: 5 }` copy cell by cell; `...rest` in a parameter list is the arguments of
  each call site, which keeps that function inlined under slice 7's rule. All of it is the
  front end: the IR does not change.
  **As built (2026-09-19).** All of it the front end's, as planned; the IR and the Python
  are untouched, and there is no probe of its own (a fixture of `tests/eud-build.test.ts`
  builds a script that uses every form). `compiler/structured.ts`, *Destructuring and
  spread*: `patternSource` is what a pattern is taken from (a record, a list, a value of
  the script, what `mouse()` and `chatted()` give, or an array written out — whose items
  go into temporaries first, which is the whole of a swap), `bindPattern` binds every name
  to a copy, `assignPattern` collects the stores and runs them after every copy is made.
  A parameter's pattern is taken apart as the first thing in the function's body
  (`walkFunction`'s `first`), so a called function does it too; a record or an array
  handed to one keeps it a called function, a copy an array as before. `...rest` of a
  parameter list is an array declared at the call, and the function stays inlined. A
  pattern is also a `for…of` variable, through the loop the array methods use. What was
  found on the way: a `const` of the *script's* taken out of a pattern never worked — the
  hoisted function referred to a name nothing declared — and its thunk now runs the
  pattern and gives the names back; `...base` inside `[ ]` was hoisted as an expression,
  which it is not. Not done: a spread into a call's arguments (`f(...xs)` — an array goes
  as itself), `...rest` on the left of an assignment, the rest of an array of records or
  of units.
- **Arrays inside things.** What 3.6 left out: a record with an array for a field
  (`{ hp: 5, path: [0, 0, 0] }`) and an array of arrays (`grid[y][x]`). Of a *fixed* shape
  both are the front end's alone: a fixed array in a record is more cells of the record, in
  an array of records one array of `length × n`; a grid whose two sizes are known is one
  array read at `y * w + x`, a row past either end reading 0 as a cell does. An inner array
  that *grows* is the new thing: its handle becomes a value kept in the cells of something
  else, so the IR gains an array reached through a handle the game holds, where until now
  every array was a declaration — and 3.6's rule of one block a declaration site no longer
  covers it. The rule that replaces it: what holds the handle owns the block; `pop`,
  `length =`, `clear` and declaring the outer again give the inner blocks back first, and a
  copy of a row (`const r = grid[y]`) is a reference, as it is in TypeScript, never a second
  owner. The strings and the map over any number, below, also keep blocks that a value
  owns: the three are designed together.
  **As built (2026-09-19; probe `probes/inside.ts` played the same day, every step as
  expected — three thousand rows pushed and cut off with nothing in red, so the heap gets
  its blocks back in the game as it does in Simulate, and both of IR 12's new storages run
  there).** Three shapes, the compiler choosing:
  - *A grid* — every row one length, none growing: one flat `ArrayDecl`, `grid[y][x]` an
    `element` at `y * width + x` whose index is −1 when `x` is past the row (a ternary over
    an unsigned compare), so nothing is made for a plain read or store. A row wanted as an
    array (`const row = grid[y]`, a loop, a method, a parameter) is a **window**, IR 12's
    `ArrayDecl.slice { of, offset }`, which both backends bound by its own length. Any
    depth. The outer array may grow by whole rows (`dims[0]` is 0 then, the rows are the
    flat length by the width); started empty, the rows that are pushed say how wide it is
    (`pushedWidths`).
  - *Rows that grow* — different lengths, or `b[i].push(…)` / `.pop()` / `.length =`
    anywhere in the body (`innerGrows`): four arrays, a handle a row, and `b[i]` IR 12's
    `ArrayDecl.through { ptr, len, room, k, index }`, a growing array whose handle's
    fields are read through the four. The Python is `InnerListStorage`, thirteen lines
    over `ListStorage`; the rule that the holder owns the block is the front end's
    (`releaseRows` before a pop, a `length =`, a declaration run again; `declareArray` of
    a row with nothing is what gives a block back). Since a row is reached by its *place*,
    a kept row cannot dangle — it is whatever is at that place — which is safer than the
    plan feared and differs from JavaScript in one documented way.
  - *An array in a record* is an array the record's name leads to: `declareRecord` hands
    the field to `declareArray` / `declareUnits` / `declareGrid` / `declareLists`. Nothing
    new in the IR.
  Also: the hoisting pass marks the list at the *root* of a store however deep
  (`grid[y][x] = v` on a `const`), and the check for a loop that never ends reads a window
  as the array it is a window on. **Left for the classes part:** an array inside an
  *array of* records (`squads[i].members`), which is a handle a row as above, the four
  arrays riding along as fields so that the rows' push / pop / sort / filter move them —
  and that is where copies of a handle appear (a filtered array's rows name the same
  blocks), so where ownership has to be said. Also left: `filter` / `sort` / `reverse`
  of an array of arrays, and three deep with rows that grow.
- **Strings.** Added 2026-09-19 at the user's word ("I would like native strings… I also do
  want full template strings such as `Wave ${n}`"). One type, `string`, written as
  TypeScript writes it, and nothing to declare beside it — no capacity, which would have
  been slice 6's first array over again. The compiler keeps it one of two ways, a variable
  at a time, and the end of the line says which:
  - *A text of the map.* A variable that only ever receives literals (and what folds to
    one: `"a" + "b"`, a `?:` between two) holds the text's id in the built map's string
    table, where eudplib puts a program's texts already — never in the map being edited.
    Assigning is copying a number; `==` compares ids, the same text being one id; `switch`
    is a switch over numbers. Any text field of any action takes it, the id written into
    the action before it runs: objectives, a leaderboard's label, a transmission, where
    until now only a literal could go.
  - *A text that was made.* `` `Wave ${n}` ``, `a + b`, `s += "!"`, `String(n)`,
    `name(p)` kept: formatted into one scratch buffer (eudplib's `f_dbstr_print`),
    measured, and copied to a block of the heap of that many bytes, four to a cell, handed
    out as an array's blocks are. The variable is three cells: the text's address — a
    literal's address is a constant of the build, through `GetMapStringAddr`, so printing
    never asks which kind it has — the block it owns, 0 when it owns none, and its length
    in characters.
  - **A string is a value, and what holds it owns its block**: the rule of the arrays
    inside things. `a = b` copies the block (a temporary is moved, not copied); assigning
    or declaring again gives the old block back first; a string in a record, an array or a
    class is given back with its holder; one local to a recursive function has its cells
    saved and zeroed as a growing array's handle is. Since a JavaScript string cannot be
    changed, a script cannot tell a copy from a reference, and copying is what needs no
    collector. A template written straight into `print()` stays what it is in 3.8: no
    block at all.
  - What it can do: templates, `+`, `+=`, `==` / `!=` (`f_strcmp` when either side was
    made, a loop over the bytes, with a hint), `switch`, `String(n)` / `n.toString()`,
    `startsWith`, `endsWith`, `includes` (`f_strnstr`; the bytes are UTF-8, where a match
    of bytes is a match of characters). Colour codes are bytes like any other. Out of
    memory is the heap's message and the simulator's fault at the same line; a text longer
    than the scratch buffer (1 024 bytes) is cut, and says so the same two ways.
  - **A character is a code point** (decided 2026-09-19). JavaScript counts UTF-16 units
    and the game holds UTF-8, so a Korean syllable is one there and three bytes here;
    bytes would make `"저글링".length` 9 and `"저글링"[1]` half a character. A code point
    is one UTF-16 unit for everything below U+10000 — Latin, every Hangul syllable, kana,
    the usual Chinese characters, the colour codes — so the numbers are JavaScript's.
    Above it (emoji, the rare CJK extensions) JavaScript counts two and this counts one;
    a literal that holds such a character gets a warning, *the game cannot draw this*, and
    a Battle.net name cannot hold one, so no text of a running map counts differently.
    (Played 2026-09-19: Remastered draws a dark grey square in its place.)
    The simulator counts the same way, `[...s].length`, so the two agree there too. With
    that settled, in the first cut: `length`, `s[i]` / `at()` / `charAt()`, `slice` /
    `substring`, `indexOf`, `padStart` / `padEnd`, `repeat`, and `for…of` over a text.
    A literal's length is a constant of the build and a made text's is counted as it is
    made — the bytes are walked then anyway — and kept in a third cell, so `length` is
    free. What is not JavaScript's is the cost of a place: UTF-8 has no fixed width, so
    `s[i]` and `slice` walk from the start, and `s[i]` in a loop over a long text gets a
    hint that names `for…of`, which walks once. The README says of `padStart` what is
    true in a browser too: it counts characters, the game's font is proportional and a
    colour code has no width, so it does not line columns up.
  - **A made text in a field that is not `print`** (decided 2026-09-19: it works without
    the script saying anything, where the game allows it). An action takes an id, not an
    address. The compiler reserves a string of the built map's table — 255 bytes of room,
    added with `ForceAddString` so no other string shares its bytes — and copies the made
    text over it just before the action that names its id runs. **One a kind of field,
    not one a call site**: a player has one objectives text, one leaderboard, one
    transmission at a time, so a later call replaces an earlier one on the screen anyway,
    and a map pays for four or five such strings however many calls it has. **Written
    only on the machine of the player it is for**, if the game turns out to read the
    string again each time it draws: a per-player program runs the action for every
    player on every machine, and the last one's text would be everybody's. The slot is
    memory nothing of the script can read back, so a write that differs by machine
    cannot desynchronise. What the script sees is a snapshot, as a string value is in
    TypeScript: changing the variable afterwards changes nothing on the screen until the
    call runs again. A text past the room is cut, a fault in the simulator. **A verdict
    a field**: `probes/strings-spike.py`, hand-written eudplib built beside a script that
    does nothing (`EXTRA_PLUGIN` of `scripts/build-fixture.mts`), tries Display Text (the
    control), the objectives, a leaderboard's label, a transmission and a unit type's
    name, and for each writes the slot again *without* the action to see whether the game
    copied the text or reads it each time. A field that fails keeps its error, naming
    `print`. The transmission also answers something older: it is a waiting action, and
    eudplib warns that one inside its loop holds everything up.

    **Played 2026-09-19.** The objectives, a leaderboard's label and a unit type's name
    all show a made text, and all three are **read again each time they are drawn**: the
    objectives opened after the slot was written over said the new text with no action
    run, the label counted every second, and the Marines were renamed by a write to the
    slot alone. The write to the name's entry (`0x660260`) did not end the game. So:
    - these three fields take a made text in the first cut;
    - the write is for the local player only — put exactly, *the slot is written on a
      machine whose player is among those the action is for*: one player named, that
      player's machine; `AllPlayers` or a force, every machine in it, the text being one
      for all of them. A unit type's name is nobody's in particular and is written
      everywhere, from values every machine has;
    - a name needs a slot a unit type, not one a kind, so the type is a constant of the
      build there (a slot each for the types a script names);
    - a slot belongs to the compiler: nothing else writes it, so what is on the screen
      still changes only when a call runs, as a snapshot should. (That the game reads it
      again is what a label that follows a variable by itself would be built on. Not in
      this slice: it is not what the TypeScript says.)
    A transmission's line was the made text too, so it is the fourth field in the first
    cut; whether that line is copied or read again was not seen, and the write is for
    the local player either way. Nothing was seen to stop while the transmission was up,
    for all eudplib's warning about a waiting action in its loop. Korean is drawn as
    written; an emoji is not drawn at all, which is what the warning on a literal says.
    **As built (2026-09-19; probe `probes/strings.ts` played the same day: every step as expected, the one red line at step R and none before it, and the emoji of step Q a dark grey square — so the Python text run time, the slot strings under `IsUserCP` and the heap's accounting all hold in the game).** IR 13: a
    `text` kind beside number, boolean and unit, `VarDecl.text` (`id` / `made`), one
    `TextExpr` type that a backend works out either as an id or as a text that is
    somewhere (`docs/ir.md`, *Texts*). What was decided on the way:
    - *Which way a variable is kept* is read off the body when it is declared
      (`structured.ts`, `textKept`): the first value and every `=` to it have an id — a
      text written out, a `? :` between two, `titles[level]`, another variable kept that
      way — and nothing `+=`s it. A value the script works out later in the body is asked
      for then, which is earlier than the walk would have; a helper with a side effect
      runs once all the same. A record's text field is decided the same way, by the
      assignments to that property.
    - *The block* holds its own size class in its first cell, so a variable is the three
      cells planned (where, block, length) and giving a block back needs nothing more. A
      copy is a block of the same class and a copy of its cells, whole dwords.
    - *The length* is counted when a text is made, by walking its bytes once more rather
      than adding the parts' lengths up: simpler, and a made text is at most 1 023 bytes.
    - *The scratch* is twice a text's most: parts are written a group at a time, a group
      being what cannot pass 1 023 bytes, with a check of where the writing has got to
      between groups; a text of the program goes in through a copy of its own that stops
      at the scratch's end, since a text of the table may be any length. Then the cut,
      never inside a character.
    - *Operands and calls*: a variable's text is only looked at, so when a later operand
      holds a call — which may give the variable another text — it is copied first.
    - More than planned, because it cost nothing once the rest was there: `<` `<=` `>`
      `>=`, `codePointAt`, `concat`, `s || other`, `s.at(i) ?? other`, a text-valued
      `? :`.
    - **Less than planned, each refused with a message that says what to do instead:** a
      function that calls itself cannot hold a text (the plan had its cells saved and
      zeroed; the recursion pass refuses it); a function that takes or returns a text
      stays a copy at each call; an array of texts a program fills, and a text in an
      array of records, wait for the classes, where a row's handles ride along anyway. A
      text temporary inside a loop's *condition* is refused too, since a condition is
      worked out again every turn and a temporary is made once.
    - The simulator keeps JavaScript strings and counts blocks as the lowering does —
      same sizes, same order — so both run out at the same text.
    The probe, steps A–R: kept across a sleep, a copy that does not follow, texts of the
    map chosen by a variable, comparing, Korean counted and cut, pad and repeat, for…of,
    switch, functions, 3 000 made with the heap whole after, the four fields, a program
    of every player, an emoji, and a text past 1 023 bytes for the one red line.
  - Out, with an error: a key of a `Map` that is a made string (a union of literals is a
    record already); `parseInt`; regular expressions; a word taken from chat
    (`chatted(p, "-name {word}")`), which can follow once the chat plugin's buffer has been
    looked at.
  - IR: a text value beside the number, `VarDecl.text` (`"id"` / `"made"`), the operations
    above as nodes of their own. The simulator keeps JavaScript strings and counts blocks
    by their UTF-8 length, so it runs out where the game does.
- **Classes.** A class used inside a program is a record and its methods functions with the
  instance first; `new` declares the cells and runs the constructor; a field that is an
  array (`members: Unit[]`) or a text (`name: string`) is one of the two parts above. Whether a method is
  called or inlined is slice 7's rule, nothing of its own. Fields, methods, getters and
  setters, `static`, `readonly`, `private` and `#x`. `extends` works because the class of
  every value is known when the script is built — there is no type when the map is played —
  so `super`, an overridden method and `instanceof` are all settled at build time, and an
  array of a base class that holds two different subclasses is an error. An array of
  instances is the array of records 3.6 has.
  **As built (2026-09-19; probe `probes/classes.ts`, steps A–K, played the same day and again once an instance was made straight on its row, below: every step as expected both times, nothing in red at step I — so IR 14's Python, a text in the cells of a row stored, copied by `filter`, moved by a sort and given back, holds in the game, as do the rows' arrays and units).** A class
  *declared in the program* (or in a `game()` function) is the program's, as a function
  declared there is; one declared outside stays the script's. That was the decision that
  made the rest small: the hoisting pass already plans every body inside the program, so a
  class's methods, constructor and field values are planned like a declared function's
  (`hoist.ts`, `classItems`), and the class's name is a game binding, which is what keeps
  `new Squad(3)` from being worked out as a value of the script.
  - *An instance* is the `record` binding with its class on it (`scope.ts`, `cls`).
    `instantiate` / `construct` (`structured.ts`, *Classes*) declare the fields under the
    declaration's name and run the constructor through `inline`, what the class extends
    first: a class with no `extends` gets its fields' values before its constructor's first
    line, one with `extends` when `super(…)` comes back, as JavaScript does it. A field's
    declaration is a record's (`declareField`, shared with `declareRecord`), so a text, an
    array, a record and another instance came with it.
  - *A method, a getter, a setter, a static method* are `inline` with the instance bound
    to `this` (a key of the scope that no declaration has). The instance goes last among
    what a called function is handed, as a binding, so slice 7's rule covers it with no
    rule of its own: a method is called from its second call on, one copy an instance, and
    one that calls itself is recursion's (probe step D). A method on a *row* is always
    inlined, a row being a binding made anew each time — see below.
  - *An overridden method, `super`, `instanceof`* are settled by the class the binding
    carries, never the declared type, so a `Bird` handed to `f(a: Animal)` runs `Bird`'s
    methods there. `instanceof` is answered in `evaluate`, so the false branch is pruned.
  - *Static fields* are variables declared where the class statement stands.
  - *An array of instances* is the array of records, holding one class: the one every
    `new` written into it, pushed to it or stored in it names (`rowClass` reads the body),
    or the declared one. `push(new C(…))`, `xs[i] = new C(…)`, `[new C(…), …]`; pushing an
    instance kept in a variable is refused rather than copied.
  - **What a row holds** is what parts 3 and 4 left here. A records binding has a *shape*
    (`RowShape`): a unit is three columns, an array that grows four (the row's handle —
    its columns *are* a `lists` binding, so `squads[i].seen` is part 3's `inner` with no
    new IR), an array of units twelve, a record or an instance its columns under its name,
    a text three. Every field being plain columns is what keeps push, pop, sort and
    reverse moving a row whole without knowing what is in it. The row owns its blocks:
    `pop`, `length =`, `xs[i] = …` and the array declared again give them back
    (`releaseRow` / `releaseFrom`); `filter` gives its rows arrays and texts of their own;
    a sort holds a row that owns blocks as a row past the end, since an array in it is
    reached through a row and temporaries are none.
  - **IR 14** for the text in a row only: `textAt` (three cells read as a text that is
    looked at), `storeText`, `releaseText`. Thirty lines of Python, which is what the probe
    is for; the simulator keeps such a text under the number in its cells.
  - Also: `this.members = []` (and `p.trail = [a, b]`) starts an array a field leads to
    over; `const same = s` is another name for an instance; `new` as an argument.
  - **Left out, each refused with a message:** a function that returns an instance, and a
    variable given another instance (both need a class at run time); `string[]` a program
    fills (an array of records with a text for a field does it); an array of arrays, or of
    records, inside a row; a class expression, type parameters, static blocks, decorators.
    Still owed from part 4 and not needed by anything here: a text local to a function
    that calls itself, and a function that takes or returns a text becoming a called one.
  - **An instance is made straight on its row** (the same day, at the user's word):
    `push(new C(…))`, `xs[i] = new C(…)` and `[new C(…)]` first made the instance in
    variables of its own and copied it in, the arrays cell by cell. Now the row is there
    first, with nothing in it, and is `this`: a field's first value and a parameter that
    declares a field are stored into its cells (`rowFieldGiven`, which is `rowField` again),
    and `this.x = …` was a store already. One thing JavaScript does differently had to be
    kept: what `new` is handed is worked out *before* the row is there, so
    `waves.push(new Wave(waves.length))` must see the old length. Where an argument names
    the array, or holds a call, the instance is still made apart and copied
    (`copiedRow`). The probe went from 690 KB to 574; what is left is the row itself — the
    probe's `Squad` is 25 cells, a `Unit[]` alone twelve — and a whole row moved is a
    statement a cell. A constructor's *body* that reads the array's length sees the row
    already there, which JavaScript's would not; nothing says so.
- **A map over any number.** `Map<number, V>` and `Set<number>`: open addressing in a block
  of the heap, exchanged for one twice the size at three quarters full, as an array that
  grows is. A few probes an operation where a keyed table is one read, so the hint says
  which one a `Map` became. To decide when it is built: JavaScript iterates a `Map` in the
  order the keys went in, and keeping that costs a second block of keys — either pay it, or
  say in the README that the order is not kept.
  **As built (2026-09-19; probe `probes/map.ts`, steps A–I, played the same day: every step as expected, nothing in red at step F, and step G — 400 `has()` of a Map of 64 within one frame — without a pause that could be seen, so a search's three bitwise operations are not felt).** Decided by
  the user: the order is JavaScript's, as far as it can be matched. So the table is two
  things, the way a JavaScript engine's is: the *entries* in the order they went in —
  three arrays that grow, a key, a value, whether it is still there — and the *slots* a
  key is found through, a power of two of cells holding an entry's place plus one. A key
  set again stays where it was; one deleted is marked, and set again is a new entry at the
  end; a loop goes up the entries by place and asks the length again every turn, so what
  its body adds is reached and what it deletes is not. A deleted entry keeps its slot, so
  what was put in after it is still found; the slots are made again when three quarters
  are taken — at twice the size when more than half would be, and without the deleted
  entries, the rest closing up in their order. Closing up moves the place a loop is at, so
  it waits while any loop goes through the table (`walking`, counted out before a `return`
  that leaves the loop). Where a search starts is the key's two halves folded together
  under the mask, so keys alike in their low sixteen bits spread out.
  - **Nothing new in the IR, and no Python.** The work is five functions of the table's
    own, written as IR by the front end and called (`hashFunction`: find, place, grow, put,
    drop); `get` is a function of the compiler's with the call of `find` inside it, as
    `includes` is one. A table is a binding (`hash`), handed to a function as itself and a
    field of a record or a class.
  - **The tests run JavaScript.** `tests/hash.test.ts` runs each body through the
    simulator and the same lines through `new Function`, and compares what was printed —
    four hundred operations at random among them, keys from −2³¹ to 2³¹ − 1, deleting
    while a loop runs. The probe's expected lines were worked out the same way.
  - Left out, each with a message: a text for a key (the plan had it out), a unit for a
    key, `[...m.keys()]` and whatever else makes an array of one, `set` in a chain, a value
    that is more than a number or a boolean.

What stays out, each with an error that says so: a function as a value, generators and
`async` (an error already), `try` / `throw`, and anything that needs a type at run time
(`typeof x === …` on a value of the game). (As built there are five probes, one a part
that needed one — see the table above.) As first planned, one probe, `probes/callbacks.ts`: a sort of 256
cells timed in the frame, a `filter` that grows past its first block, a grid filled and
read back, an array of arrays that grow with the outer one cut and the blocks found again,
a text of the map chosen by a variable and shown in `print`, the objectives and a
leaderboard, a made text kept across a `sleep` and shown later, a hundred made in a frame
and the heap found whole after, Korean text compared, found, counted and cut in the middle,
an emoji to see what the game draws of it, a made text in each field
that is not `print`, a class with an array of instances and a name, and a `Map` through
two doublings.

Slice 1 is where the value is and where the risk is; nothing after it is hard once the IR
and the Python lowering exist. Slices 2–4 can be reordered by what the user wants to play
with first; 5 and 6 are what make it feel finished.

## Open decisions

- ~~The name for a unit on the map.~~ Decided 2026-09-17: `Unit` is the unit on the map,
  `UnitType` the table entry, renamed in slice 1 (no users yet, so no migration).
- ~~Signed numbers.~~ Decided 2026-09-18: `number` is signed, `u32` is the unsigned type
  beside it (slice 5).
- **Reads on the classic target.** Planned in slice 2 for parity, with cost hints; they
  could be Remastered-only if the decomposition cost makes them a trap.
- **Where the built map goes.** Beside the source as `<name>-eud.scx`, like Magenta. The
  alternative, writing the payload into the source map, would make the editor's own
  trigger list unreadable and is not recommended.
- ~~Functions as real calls.~~ Decided 2026-09-18: the compiler chooses (slice 7), and
  recursion follows (slice 8).
- ~~A map over any key.~~ Decided 2026-09-19: the last part of slice 8½, in the heap
  rather than with a capacity. It keeps the order its keys went in, as JavaScript does
  (the user: "match js as much as possible"); the tests compare with JavaScript itself.
- ~~Where a class is declared.~~ Decided 2026-09-19 while building: in the program (or a
  `game()` function) that uses it, as a function is. One declared outside is the script's.
  If classes shared between programs or files are wanted, the way in is what `game()` is
  to a function: the class's bodies planned on their own and found again from its value.
- ~~Strings.~~ Decided 2026-09-19: a value of the language, in slice 8½ — a text of the
  table as its id, a made text as bytes in the heap, no capacity declared; a character is a
  code point. Left open: which fields besides `print` show a made text, which the probe
  answers.
- **A limit on scans.** A loop over every unit on every frame in a per-player program is
  twelve scans a frame. A hint is planned; a hard cap is not.
- **The classic install on the Remastered target.** As of 2.6 every compile still runs the
  classic backend and Build still writes the classic block into the source map, so a script on
  the Remastered target must fit Classic's limits (death counters free, the forms of division
  Classic takes) and pays Classic's trigger counts. No limit can be lifted until that is
  optional. The choice: a Remastered script skips the classic block entirely (the source map
  then carries the script but no playable triggers of its own), or keeps a classic block only
  for what Classic can express and leaves the rest to the built map. To settle before slice 2,
  since reads and text cannot compile on Classic as they are.
- ~~Rate limiting the server.~~ There is no server: the build runs in the editor.
- ~~Offline.~~ Solved by the eudplib plugin: after its one-time download every build is
  local, on the desktop as on the web.

## Facts this plan leans on

- plugin-eudplib 0.2: `eudplib.build` service — `{ map, plugins, sources, files, options }`
  → `{ map, log, chkBytes, ms }`; plugin values single-line and 64 KB, sources 512 KB each,
  files 4 MB in all; one build per worker, about 2 s of Python start plus the build (a
  probe map builds in under 4 s in the browser); eudTurbo is one of the bundled plugins.
- Magenta's probes 5–11 (2026-09-14/15): what passed and what exits the game; MSQC key
  pulse is one frame, mouse base is 1-based, chatEvent wants exactly two `.*`, a scratch
  box location for orders, generated guards should be counters not switches.
- eudplib 0.81: `EUDVariable`, `EUDArray`, `EUDIf`/`EUDWhile`/`EUDSwitch`, `EUDFunc`,
  `f_dwread_epd`, `CUnit` fields, `EUDLoopNewUnit`, `f_simpleprint`, `PName`/`PColor`,
  `f_rand`, `f_mul`/`f_div`; no `CImage` export.
- TrigScript 2.5.1: the language reference in README, `Machine.sleep`'s state split,
  the two-phase allocation, the 137 tests, the workspace hooks.
