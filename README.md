# TrigScript

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It keeps TypeScript files inside the map and builds them into
ordinary triggers. There is no EUD trickery involved; what it produces runs on any
version of the game.

The files are real TypeScript. They *run* when you build, and every `trigger()` call they
make records one trigger of the map, so helpers, loops over the players, arrays, classes
and the standard library are all there. Code inside `program(() => { … })` is the
exception: it runs in the game, as a state machine of death counters, and that is where
`if`, `while` and variables mean what a trigger can do.

The editor is Monaco with a `.d.ts` generated from the open map, so `locations.`,
`switches.`, `units.` and `players.` complete to what your map actually has, and a
location passed where a unit belongs is a type error before you build.

## Install

It is in scmJS's plugin list: open **Plugins ▸ Browse Plugins…** and install it. To add
it by hand, paste

```
https://github.com/scm-js/plugin-trigscript
```

into **Manage Plugins…** and press **Add**. To pin a version, add a ref:
`github:scm-js/plugin-trigscript@v2.0.0`.

Monaco, the TypeScript compiler and the standard library's declarations are not loaded
with the plugin's own files: the first time the editor opens they are fetched from
jsDelivr — Monaco and the library from this repository's own build of them (`dist/`),
TypeScript from the npm package's `lib/typescript.js` — so that first open needs a
connection. The browser keeps them in its cache afterwards, which is also what the
desktop build relies on when it is offline.

## Use

**Triggers ▸ TrigScript…** opens the map's script. The list at the left is its files:
`main.ts` is where a build starts, **New file** adds another, and a file's ✎ and × rename
and remove it. Edits are saved into the map as you type (the files are members of the
archive, like a sound); only **Build** changes triggers.

**Build** runs the script and installs the triggers it recorded as one contiguous block
of the map's trigger list, replacing the previous block or appending the first one.
*Build & Close* does that and closes.

The Trigger Editor shows those triggers with a `script` badge and will not edit them;
*Open TrigScript* there jumps to the file and line. The Text Trigger Editor fences them
in comments. Hand-made triggers around the block are left alone, and inserting one
before the block just moves it, since the block is found by content rather than
position.

Editing a generated trigger from outside makes the block *stale*: it reverts to ordinary
triggers, and the next Build appends a fresh block. **Import map triggers** goes the other
way, rewriting the hand-made triggers as script in their existing order around the block,
so the whole list becomes script-generated.

**Simulate** runs the built triggers for thirty cycles in a built-in trigger-cycle
interpreter and lists every action that ran, with its cycle and source line, plus each
program variable's final value. It models the things the compiler relies on: death
counters, switches, preserve, list order, wrapping addition and saturating subtraction.
Unit conditions answer "false". The same interpreter is what the test suite uses to
prove programs behave.

The files and a build manifest live in the map archive itself, under `trigscript\`
(`trigscript\main.ts`, `trigscript\build.json`, …) next to `staredit\scenario.chk`, so
they travel with the `.scx`. The editor's Save dialog lists them under the archive's
other files, with a tick each, so a copy for release can leave the source out.

A script written for this plugin's predecessor, Trigger Script, is not converted: it
was a different language. Its file stays in the archive untouched.

## The language

### Triggers

A script is a TypeScript module. The library is available as globals and as the module
`"trigscript"`, so both of these work:

```ts
import { trigger, bring, displayText, preserve, units, locations, P1, AllPlayers, CurrentPlayer } from "trigscript";

trigger(AllPlayers, [
  bring(CurrentPlayer, units.AnyUnit, locations["Beacon Alpha"], ">=", 1),
], [
  displayText("You found it!"),
  preserve(),
]);
```

```ts
for (const p of [P1, P2, P3]) {
  trigger(p, [deaths(p, units.TerranMarine, ">=", 10)], [setDeaths(p, units.TerranMarine, "set", 0), displayText("Ten lost.")]);
}
```

`trigger(players, conditions, actions, options?)` records one trigger. `players` is a
player or an array of them; `conditions` and `actions` are arrays of what the condition
and action functions return — nested arrays are flattened and `false` / `null` /
`undefined` entries are skipped, so a helper can return a list and a condition can be
`enabled && bring(…)`. The options are the execution flags by name: `{ preserve: true }`
is the same as a `preserve()` action; `disabled`, `ignoreGameEnd` and the rest are there
too.

Every condition and action is a function named after StarEdit's, in camel case:
`bring`, `deaths`, `switchIs` (the one whose real name is a reserved word),
`commandTheMostAt`, `createUnit`, `displayText`, `setDeaths`, `runAiScript`, `wait`,
`victory`. Arguments come in the order the classic editor shows them, and the enumerated
ones take short words — `">="`, `"<="`, `"=="`; `"set"`, `"add"`, `"subtract"`; `"set"`,
`"clear"`, `"toggle"`, `"randomize"` — with StarEdit's own labels (`"At least"`) accepted
as well. `displayText(text)` always displays; `displayText(text, false)` does not. A
count is a number or `"All"`.

Because the script runs, anything TypeScript can do at build time is fair game: a class
per base, a table of waves, `Array.from`, template strings, `Math`, a function that
returns the ten triggers a shop needs. Files import each other with `import { x } from
"./name"`; nothing else can be imported. What the script records is what the map gets,
and the order of `trigger()` calls is the order of the triggers.

Names come from the map. `identifier()` derives an identifier from each display name
(`Terran Marine` becomes `units.TerranMarine`), and the display name itself still works
as an index (`units["Terran Marine"]`), as do custom names the map sets, force names
under `players`, and switch names under `switches`. `P1` … `P12`, `CurrentPlayer` and
`AllPlayers` are constants; the rest of the player groups are under `players`. Raw
numbers are accepted wherever a name is, which is how you reach EUD players and
out-of-range unit ids. Types the tables do not know can be written as `condition(type, …)`
or `action(type, …)`, and `memory(address, comparison, value)` / `setMemory(address,
modifier, value)` are the standard `deaths`-at-`EPD(address)` forms.

### Programs

```ts
const spawnAt = locations.Spawn;
function burst(n: number) { return [createUnit(P2, units.ZergZergling, n, spawnAt), displayText(`Wave of ${n}`)]; }

program(() => {
  let wave = 0;
  let alarm = false;

  function next() {
    burst(4);
    wave += 1;
  }

  while (true) {
    if (bring(P1, units.AnyUnit, locations.Beacon, ">=", 1) && !alarm) {
      alarm = true;
      displayText("They are coming.");
    }
    if (alarm) next();
    if (wave >= 10 || deaths(P1, units.TerranMarine, ">=", 50)) defeat();
    wait(2000);
  }
}, { owner: P1 });
```

Everything inside the arrow runs in the game. **Variables are death counters.** A
`let n = 0` takes a death counter on a unit that can never die (the "(Unused)" entries of
units.dat, Cantina first), twelve players per unit, so there are hundreds available. A
`let f = false` takes a switch. Values are unsigned 32-bit and `-=` saturates at 0.

**Control flow is a program counter.** Each basic block is a run of preserved triggers
testing `pc == S`, in list order, so straight-line code runs inside a single trigger
cycle and only a loop's back edge waits for the next one. `while (true) { … }` is
therefore a game loop running once per cycle: roughly every 2 s at Normal speed, or every
frame with hyper triggers (`hyperTriggers(P8)` anywhere outside a program emits them).

`if`/`else`, `while`, `do`, `for`, `break` and `continue` all work. `&&`, `||` and `!` are
lowered to disjunctive normal form, one trigger per product, with negation folded into
the comparison where the game can express it (`!bring(…, ">=", 1)` becomes "at most 0")
and a skip trigger where it cannot (`!commandTheMost(…)`). `random()` is a randomized
switch.

**Functions declared in the body are inlined** at every call site. A parameter binds to
a value or, if the argument is a variable, to that variable by reference. `return` works;
return *values* do not. Locals get their own storage per call site.

**Everything the body reads from outside is computed when you build.** A constant, a
helper, a condition, an action, a `const` declared in the body: each is evaluated once,
when the script runs, and the compiler sees its value where the expression stood. That
is what makes `burst(4)` above work — the helper is ordinary TypeScript, it returns two
actions, and the program emits them. It is also the one rule to keep in mind: a program
variable can never reach a condition, an action or a helper, because those are computed
before the game starts. `createUnit(P2, units.ZergZergling, wave, spawnAt)` is an error
saying so; compare and assign variables in the program's own statements instead. A
parameter of an inlined function that was bound to a value does reach them, so
`function spawn(p: Player, n: number) { createUnit(p, units.Zergling, n, spawnAt); }`
works with `spawn(P2, 4)`.

Cost matters here. `n += 5`, `n = 3` and `n++` are one action each. An operation between
two variables (`a += b`, `a = b`, `a < b`) is the classic binary decomposition and costs
about 64 triggers, so keep those out of hot loops. There is no multiplication or division
between variables, because the game has no instruction for it; `*`, `/` and `%` work on
build-time values.

**A program is one thread running as one player**, its `owner` (default P1). It runs
only while that player is in the game, and `CurrentPlayer` means that player. A script
may have several programs; each gets its own program counter and variables, and the
options are `owner`, `comments` (a Comment action naming the source line on every
generated trigger, which is what the Trigger Editor shows as the trigger's title; default
on) and `variableUnits` (unit types whose death counters hold this program's variables).
The allocator avoids every death counter and switch the map's hand-made triggers touch or
its switch names claim, and the toolbar's program summary lists where each variable lives.

## For other plugins

The plugin registers commands, so another plugin gets the script without the editor
through `api.commands.run` (check `api.commands.has` first, and listen to the
`"commands"` event if you need to know when it arrives — plugins activate in no fixed
order). A `source` argument is either the text of `main.ts` (the map's other files stay
as they are) or an object of every file by path.

| Command | |
| --- | --- |
| `trigscript.state()` | `{ files, source, manifest, block, stale, unbuilt }`: the map's script files, `main.ts` on its own, where its built block sits in the trigger list (null when the records were edited by hand — `stale`), and whether the files differ from what was last built. Null with no map. |
| `trigscript.declarations({ compact? })` | The generated `.d.ts` the script type-checks against — the whole vocabulary for this map. `compact` is the shorter variant meant for a language model. Empty with no map. |
| `trigscript.compile(source)` | A promise of a `CompileResult`: `ok`, `diagnostics` (`file`, 1-based `line` / `column`, `message`, `source: "typescript"`, `"compiler"` or `"script"` for an error the script threw), the records, `sources` (per record, the file and line it came from), the variable allocation, the `programs`. A newer compile supersedes an unfinished one, which rejects with `CompileSuperseded`. |
| `trigscript.build(source, { takeOver? })` | Compile and, when clean, install the block (or append when the old one was edited) and store the files with the map: a promise of `{ compiled, block }`, `block` null when there were errors. `takeOver` replaces the whole trigger list with the script's. A settings-style transaction: not undoable, marks the map modified. |
| `trigscript.print(triggers, { imports?, header? })` | Records as `trigger()` calls in the script language — what Import map triggers writes. `imports` starts the text with an import of the names it uses. |
| `trigscript.simulate(triggers, cycles, { player? })` | The interpreter: `{ cycles, events, switches }`. |
| `trigscript.triggerAt(file, line)` | Which trigger (index in the map's list) a 1-based line of a file generated; null when none did or the block is stale. |
| `trigscript.open({ file?, line? })` | Open the editor, on a file and line. |

The scmjs.dev plugin's *Write Triggers…* is built on these.

## Development

```sh
npm install
npm run typecheck   # tsc over the plugin and its tests, against @scm-js/plugin-api
npm test            # vitest: the runtime, the plan, the lowering, the simulator, the block logic
```

The layout:

| | |
| --- | --- |
| `plugin.ts` | Activation: the menu item, the claim on the generated block (`api.triggers.claim`), the commands. |
| `service.ts` | What the plugin does to the map: names off `api.settings` / `api.names` / `api.query`, the members through `api.document.extras`, a build as one `document.update`. |
| `editor.ts` | The dialog: the file list and Monaco, plain DOM in the editor's own classes. |
| `monaco.ts` | Monaco from `dist/` on jsDelivr's GitHub mirror (the tag `DIST_TAG` names; the workers start as blob module workers), one model per file under `file:///` so imports resolve, the theme. The plugin storage key `monacoDist` overrides where the files are fetched from — set `scmjs.plugin.trigscript.monacoDist` in the browser to `"http://localhost:3000/dist"` while developing. |
| `bundle/`, `dist/` | `npm run bundle` builds Monaco with esbuild — the editor core, its features and the TypeScript language alone, styles injected by the module and the codicon font inlined, plus the two workers — and writes `lib.d.ts`, the standard library the compile worker checks scripts against (`bundle/lib.mjs`), into `dist/`, which is committed. A CDN's on-the-fly bundler turns Monaco's lazy language chunks into standalone bundles carrying a second editor core, which is why the plugin carries its own. After a Monaco bump: rebuild, commit, tag `monaco-<version>-<n>`, move `DIST_TAG`. |
| `compile.ts` | Compiling in a worker: a blob worker `importScripts` TypeScript from the CDN, fetches `lib.d.ts` once, and imports this plugin's own compiler module by the `blob:` URL the editor's loader gave it; a request the script does not answer in fifteen seconds (an endless loop outside `program()`) terminates the worker. A main-thread fallback loads TypeScript through a `<script>` tag. |
| `script.ts` | The files, the block and its manifest: hashing, finding the block by content, staleness, planning a build. Pure over a trigger list and a map of the members. |
| `compiler/` | The language. `names.ts` and `declarations.ts` generate the `.d.ts`; `runtime.ts` is the library the script calls; `compiler.ts` checks the files as one `ts.createProgram`, emits them through `hoist.ts`'s transformer, links and runs them (`link.ts`), and lowers each `program()` through `structured.ts` into `lower.ts`'s state machine; `simulate.ts` is the interpreter; `print.ts` is the inverse for records; `api.ts` and `record.ts` are the shared vocabulary. Nothing in here touches the DOM or the editor. |
| `vendor/` | The tables the compiler reads, copied from the editor: the trigger record layout and its codec, the condition and action definitions, the unit names, the flag names. The editor is the source of truth; copy them again when it changes. |
| `dist/plugin.js` | The bundle the editor loads; `npm run build` writes it, CI commits it. |
| `tests/` | vitest. `script.test.ts` pins the names, the declarations, the runtime's argument handling, files and imports, the printer and the block logic; `script-structured.test.ts` compiles programs and asserts the simulation. Copies of Blizzard's own maps in `fixtures/maps/` (gitignored) make every trigger eject to script and run back to the same record. |

### How the compiler is built

`names.ts` turns the map into five name tables (players, units, locations, switches, AI
scripts); each entry's keys are an identifier derived from the display name first
(`Terran Marine` → `TerranMarine`), the display name itself second, then custom names —
unique per table by construction. `declarations.ts` generates the `.d.ts` from them plus
the library: values are branded literal types (`Unit<0> = 0 & Brand<"unit">`; plain
numbers still pass, a `Location` where a `Unit` belongs does not), enumerated kinds are
string unions of the canonical words, every condition and action is a `declare function`
whose identifier is its `ConditionType` / `ActionType` key in camel case, and the whole
thing is declared twice — as globals and as the ambient module `"trigscript"`.

`runtime.ts` is the same vocabulary as values: the tables as frozen objects and one
function per condition and action that validates its arguments and returns a record.
`trigger()` pushes a record onto a `Collector`; `program()` pushes the descriptor the
transformer made for it. Strings are not interned here: text and WAV fields hold local
ids into `CompileResult.strings`, and the build resolves them through the map's string
table.

`compiler.ts` builds a real `ts.createProgram` over the files, the declarations and the
standard library (in-memory host; `module: commonjs`, `moduleResolution: bundler`), and
stops at the first type error. It then plans every `program()` body (`hoist.ts`): the
*game bindings* are the body's `let` / `var`, the parameters and the functions declared
in it; a *hoisted expression* is a maximal subexpression that mentions none of those (and
is not `random()`), and a `const` of the body whose initialiser is hoistable is a
build-time constant. The emit transformer appends its position to every `trigger()` call
and replaces each program's arrow with a descriptor holding a function that evaluates the
hoisted expressions, in the plan's numbering, with the constants declared as written.
The emitted CommonJS is linked by `link.ts` — relative imports against the files,
`"trigscript"` to the runtime, the library's names in scope as globals — and run; an
error the script throws is placed through the emitted source map.

`structured.ts` then walks each program body against the same plan, with the values the
descriptor's function returned: where the plan says an expression was hoisted, the walker
takes its value — a number, a boolean, a condition, an action or a list of them. `let` →
a death counter (number-like) or a switch (boolean-like), bound in a scope keyed by
declaration node so shadowing and inlining resolve as the checker does; numeric
expressions reduce to `c + Σ±v`; comparisons with a constant are one Deaths condition,
between variables they cancel common terms and go through `compareVars`; functions
declared in the body are inlined per call, and a call, member access or arithmetic over
values a parameter was bound to is evaluated on the spot; unreachable code after `break`
/ `continue` / `return` / an endless loop is tracked so the final `halt` is only emitted
when the program can reach it.

`lower.ts` is the machine and knows no TypeScript: a basic block is a run of preserved
triggers testing `pc == S` in list order; `[S, C] → THEN` followed by `[S] → ELSE` is
negation by ordering. The allocator hands out death counters player-major over the
"(Unused)" units and switches from 255 down. `addConst` is one action, `addVar` the
32+32-step binary decomposition through a temporary, `compareVars` builds saturating
differences into temporaries released after the branch. `Bool` trees go through a DNF
conversion with negation pushed to the leaves; a leaf the game cannot negate becomes a
negative literal with a skip step. State 0 is the entry (every counter is 0 at game
start), `halt` is 0xFFFFFFFF.
