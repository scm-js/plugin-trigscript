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
| 4 | Input | `chatted()` with captures, `keyPressed`, `clicked`, `mouse`, `underMouse`; MSQC and chatEvent composed automatically | 2–3 days |
| 5 | `test()` blocks + debugger | Tests panel, frame stepping, breakpoints, world table | 3–4 days |
| 6 | Examples, guide, assistant prompts, registry | the five examples as fixtures; README and the user guide's Remastered section; scmjs.dev's Write Triggers target-aware | 2 days |

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

Slice 1 is where the value is and where the risk is; nothing after it is hard once the IR
and the Python lowering exist. Slices 2–4 can be reordered by what the user wants to play
with first; 5 and 6 are what make it feel finished.

## Open decisions

- ~~The name for a unit on the map.~~ Decided 2026-09-17: `Unit` is the unit on the map,
  `UnitType` the table entry, renamed in slice 1 (no users yet, so no migration).
- **Signed numbers.** Not planned: 32-bit unsigned on both targets keeps one contract.
  An `i32` type could come later on the Remastered target only.
- **Reads on the classic target.** Planned in slice 2 for parity, with cost hints; they
  could be Remastered-only if the decomposition cost makes them a trap.
- **Where the built map goes.** Beside the source as `<name>-eud.scx`, like Magenta. The
  alternative, writing the payload into the source map, would make the editor's own
  trigger list unreadable and is not recommended.
- **Functions as real calls.** Inlining stays (it is what the classic target does and
  what the semantics were written for). eudplib's `EUDFunc` would shrink the payload for
  a function called from many places; a `{ inline: false }` option could come later.
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
