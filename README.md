# Trigger Script

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It is the Script Editor: one TypeScript file per map that turns
into a block of ordinary triggers. There is no EUD trickery involved; what it produces
runs on any version of the game.

The editor is Monaco with a `.d.ts` generated from the open map, so `Locations.`,
`Switches.`, `Units.` and `Players.` complete to what your map actually has, and a
location passed where a unit belongs is a type error before you build.

## Install

It is in scmJS's plugin list from the start, marked *default* and switched off: open
**Plugins ▸ Manage Plugins…** and tick it. To add it by hand, paste

```
https://github.com/scm-js/plugin-trigger-script
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-trigger-script@v1.0.0`.

Monaco and the TypeScript compiler are not loaded with the plugin's own files: the first
time the Script Editor opens they are fetched from jsDelivr — Monaco as this repository's
own build of it (`dist/`), TypeScript as the npm package's `lib/typescript.js` — so that
first open needs a connection. The browser keeps them in its cache afterwards, which is
also what the desktop build relies on when it is offline.

## Use

**Triggers ▸ Script Editor…** opens the map's script. Edits are saved into the map as you
type (the source is a file in the archive, like a sound); only **Build** changes triggers.

**Build** compiles the script and installs its triggers as one contiguous block of the
map's trigger list, replacing the previous block or appending the first one. *Build &
Close* does that and closes.

The Trigger Editor shows those triggers with a `script` badge and will not edit them;
*Open Script Editor* there jumps to the source line. The Text Trigger Editor fences them
in comments. Hand-made triggers around the block are left alone, and inserting one
before the block just moves it, since the block is found by content rather than
position.

Editing a generated trigger from outside makes the block *stale*: it reverts to ordinary
triggers, and the next Build appends a fresh block. **Import map triggers** goes the other
way, rewriting the hand-made triggers as script in their existing order around the block,
so the whole list becomes script-generated.

**Simulate** runs the compiled triggers for thirty cycles in a built-in trigger-cycle
interpreter and lists every action that ran, with its cycle and source line, plus each
variable's final value. It models the things the compiler relies on: death counters,
switches, preserve, list order, wrapping addition and saturating subtraction. Unit
conditions answer "false". The same interpreter is what the test suite uses to prove
programs behave.

The source and a build manifest live in the map archive itself, as `scmjs\triggers.ts`
and `scmjs\triggers.json` next to `staredit\scenario.chk`, so they travel with the
`.scx`. The editor's Save dialog lists them under the archive's other files, with a tick
each, so a copy for release can leave the source out.

## The language

### Two levels

**Raw** is a typed spelling of the trigger list: one `trigger()` call per trigger, with
the same argument order as the text trigger editor.

```ts
const beacon = Bring(CurrentPlayer, Units.AnyUnit, Locations["Beacon Alpha"], "At least", 1);

trigger([P1, Players.Force2], [beacon, Switch(Switches.DoorOpen, "set")], [
  DisplayText("Always Display", "You found it!"),
  SetDeaths(P1, Units.TerranMarine, "Add", 5),
  disabled(SetSwitch(Switches.DoorOpen, "toggle")),
  PreserveTrigger(),
], ["Preserve"]);
```

**Structured** is everything else at the top level: variables, `if`, loops, functions. It
compiles to a state machine built out of death counters.

```ts
program({ owner: P8, hyperTriggers: true });   // optional; defaults: P1, no hyper triggers

let wave = 0;
let alarm = false;

function spawn(count: number) {
  CreateUnit(P2, Units.ZergZergling, count, Locations.Spawn);
  wave += 1;
}

while (true) {
  if (Bring(P1, Units.AnyUnit, Locations.Beacon, ">=", 1) && !alarm) {
    alarm = true;
    DisplayText("Always Display", "They are coming.");
  }
  if (alarm) spawn(4);
  if (wave >= 10 || Deaths(P1, Units.TerranMarine, ">=", 50)) { Defeat(); }
  Wait(2000);
}
```

Raw triggers are emitted first, then the program's, then hyper triggers if you asked for
them.

### What the values are

Every argument must be a compile-time constant: a literal, a `const`, arithmetic on
constants, a template string, an array spread. Raw numbers are accepted wherever a name
is, which is how you reach EUD players and out-of-range unit ids. Types the tables do
not know can be written as `Condition(type, …)` or `Action(type, …)`.

Names come from the map. `identifier()` derives an identifier from each display name
(`Terran Marine` becomes `Units.TerranMarine`), and the display name itself still works
as an index (`Units["Terran Marine"]`), as do custom names the map sets, force names
under `Players`, and switch names under `Switches`.

The generated declarations are `noLib`: there is no `Math`, no `Array.prototype`,
nothing but the trigger vocabulary and a dozen types TypeScript insists on.

### How the structured level works

**Variables are death counters.** A `let n = 0` takes a death counter on a unit that can
never die (the "(Unused)" entries of units.dat, Cantina first), twelve players per unit,
so there are hundreds available. A `let f = false` takes a switch. Values are unsigned
32-bit and `-=` saturates at 0.

Cost matters here. `n += 5`, `n = 3` and `n++` are one action each. An operation between
two variables (`a += b`, `a = b`, `a < b`) is the classic binary decomposition and costs
about 64 triggers, so keep those out of hot loops. There is no multiplication or division
between variables, because the game has no instruction for it; `*`, `/` and `%` work on
constants.

**Control flow is a program counter.** Each basic block is a run of preserved triggers
testing `pc == S`, in list order, so straight-line code runs inside a single trigger cycle
and only a loop's back edge waits for the next one. `while (true) { … }` is therefore a
game loop running once per cycle: roughly every 2 s at Normal speed, or every frame with
`hyperTriggers: true`.

`if`/`else`, `while`, `do`, `for`, `break` and `continue` all work. `&&`, `||` and `!` are
lowered to disjunctive normal form, one trigger per product, with negation folded into
the comparison where the game can express it (`!Bring(…, ">=", 1)` becomes "at most 0")
and a skip trigger where it cannot (`!CommandTheMost(…)`).

**Functions are inlined** at every call site. A parameter binds to a constant, or, if the
argument is a variable, to that variable by reference. `return` works; return *values* do
not. Locals get their own storage per call site.

**The program is one thread running as one player**, the `owner`. It runs only while that
player is in the game, and `CurrentPlayer` means that player. Trigger conditions (`Bring`,
`Switch`, …) can be used in `if` and `while` directly. `random()` is a randomized switch.

Every generated trigger carries a `Comment` naming its source line (`L18: cycles++`),
which is what the Trigger Editor shows as the trigger's title. Pass `comments: false` to
`program()` to drop them. The allocator avoids every death counter and switch the map's
hand-made triggers touch or its switch names claim, and the toolbar's program summary
lists where each variable lives.

For EUD work the raw level offers `Memory(address, comparison, value)` and
`SetMemory(address, modifier, value)`, the standard `Deaths`-at-`EPD(address)` forms.

## For other plugins

The plugin registers commands, so another plugin gets the Script Editor without the
editor through `api.commands.run` (check `api.commands.has` first, and listen to the
`"commands"` event if you need to know when it arrives — plugins activate in no fixed
order):

| Command | |
| --- | --- |
| `trigger-script.state()` | `{ source, manifest, block, stale, unbuilt }`: the map's script, where its built block sits in the trigger list (null when the records were edited by hand — `stale`), and whether the source differs from what was last built. Null with no map. |
| `trigger-script.declarations()` | The generated `.d.ts` the script type-checks against — the whole vocabulary for this map. Empty with no map. |
| `trigger-script.compile(source)` | A promise of a `CompileResult`: `ok`, `diagnostics` (1-based `line` / `column`, `message`, `source: "typescript"` or `"compiler"`), the records, the variable allocation, the `program`. A newer compile supersedes an unfinished one, which rejects with `CompileSuperseded`. |
| `trigger-script.build(source, { takeOver? })` | Compile and, when clean, install the block (or append when the old one was edited) and store the source with the map: a promise of `{ compiled, block }`, `block` null when there were errors. `takeOver` replaces the whole trigger list with the script's. A settings-style transaction: not undoable, marks the map modified. |
| `trigger-script.print(triggers)` | Records as raw `trigger()` calls in the script language — what Import map triggers writes. |
| `trigger-script.simulate(triggers, cycles, { player? })` | The interpreter: `{ cycles, events, switches }`. |
| `trigger-script.triggerAtLine(line)` | Which trigger (index in the map's list) a 1-based source line generated; null when none did or the block is stale. |
| `trigger-script.open({ line? })` | Open the Script Editor, on a line. |

The AI plugin's *Write Triggers…* is built on these.

## Development

```sh
npm install
npm run typecheck   # tsc over the plugin and its tests, against @scm-js/plugin-api
npm test            # vitest: the compiler, the lowering, the simulator, the block logic
```

The layout:

| | |
| --- | --- |
| `plugin.ts` | Activation: the menu item, the claim on the generated block (`api.triggers.claim`), the commands. |
| `service.ts` | What the plugin does to the map: names off `api.settings` / `api.names` / `api.query`, the members through `api.document.extras`, a build as one `document.update`. |
| `editor.ts` | The Script Editor dialog, plain DOM in the editor's own classes. |
| `monaco.ts` | Monaco from `dist/` on jsDelivr's GitHub mirror (the tag `DIST_TAG` names; the workers start as blob module workers), the `noLib` language service, the theme. The plugin storage key `monacoDist` overrides where the three files are fetched from — set `scmjs.plugin.trigger-script.monacoDist` in the browser to `"http://localhost:3000/dist"` while developing. |
| `bundle/`, `dist/` | `npm run bundle` builds Monaco with esbuild — the editor core, its features and the TypeScript language alone, styles injected by the module and the codicon font inlined, plus the two workers — into `dist/`, which is committed. A CDN's on-the-fly bundler turns Monaco's lazy language chunks into standalone bundles carrying a second editor core, which is why the plugin carries its own. After a Monaco bump: rebuild, commit, tag `monaco-<version>-<n>`, move `DIST_TAG`. |
| `compile.ts` | Compiling in a worker: a blob worker `importScripts` TypeScript from the CDN and imports this plugin's own compiler module by the `blob:` URL the editor's loader gave it; a main-thread fallback loads TypeScript through a `<script>` tag. |
| `script.ts` | The block and its manifest: hashing, finding the block by content, staleness, planning a build. Pure over a trigger list and a map of the two members. |
| `compiler/` | The language. `names.ts` and `declarations.ts` generate the `.d.ts`; `compiler.ts` walks the script's AST against a real `ts.createProgram`; `structured.ts` walks statements into `lower.ts`'s state machine; `simulate.ts` is the interpreter; `print.ts` is the inverse for raw records; `api.ts` and `record.ts` are the shared vocabulary. Nothing in here touches the DOM or the editor. |
| `vendor/` | The tables the compiler reads, copied from the editor: the trigger record layout and its codec, the condition and action definitions, the unit names, the flag names. The editor is the source of truth; copy them again when it changes. |
| `dist/plugin.js` | The bundle the editor loads; `npm run build` writes it, CI commits it. |
| `tests/` | vitest. `script.test.ts` pins the names, the declarations, the compiler's argument handling, the printer and the block logic; `script-structured.test.ts` compiles programs and asserts the simulation. Copies of Blizzard's own maps in `fixtures/maps/` (gitignored) make every trigger eject to script and compile back to the same record. |

### How the compiler is built

`names.ts` turns the map into five name tables (players, units, locations, switches, AI
scripts); each entry's keys are an identifier derived from the display name first
(`Terran Marine` → `TerranMarine`), the display name itself second, then custom names —
unique per table by construction. `declarations.ts` generates the `.d.ts` from them plus a
fixed runtime; values are branded literal types (`UnitId<0> = 0 & Brand<"unit">`; plain
numbers still pass, a `LocationId` where a `UnitId` belongs does not), enumerated kinds
are string unions of the choice labels and aliases, and every condition and action is a
`declare function` whose identifier is its `ConditionType` / `ActionType` key.

`compiler.ts` builds a real `ts.createProgram` (declarations + script, in-memory host)
and walks the script's AST; it takes the `typescript` namespace as an argument so the
tests (Node) and the worker share it. Every argument is evaluated by asking the checker
for the expression's literal type, else folding arithmetic and template strings, else
following a `const` initialiser. Strings are not interned in the compiler: text and WAV
fields hold local ids into `CompileResult.strings`, and the build resolves them through
the map's string table. `CompileOptions.reservedDeaths` / `reservedSwitches` keep
variables off storage the map already uses.

`lower.ts` is the machine and knows no TypeScript: a basic block is a run of preserved
triggers testing `pc == S` in list order; `[S, C] → THEN` followed by `[S] → ELSE` is
negation by ordering. The allocator hands out death counters player-major over the
"(Unused)" units and switches from 255 down. `addConst` is one action, `addVar` the
32+32-step binary decomposition through a temporary, `compareVars` builds saturating
differences into temporaries released after the branch. `Bool` trees go through a DNF
conversion with negation pushed to the leaves; a leaf the game cannot negate becomes a
negative literal with a skip step. State 0 is the entry (every counter is 0 at game
start), `halt` is 0xFFFFFFFF.

`structured.ts` walks the statements: `let` → a death counter (number-like) or a switch
(boolean-like), bound in a scope keyed by declaration node so shadowing and inlining
resolve as the checker does; numeric expressions reduce to `c + Σ±v`; comparisons with a
constant are one Deaths condition, between variables they cancel common terms and go
through `compareVars`; functions are inlined per call; unreachable code after `break` /
`continue` / `return` / an endless loop is tracked so the final `halt` is only emitted
when the program can reach it.
