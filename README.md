# TrigScript

TrigScript is a plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based
StarCraft: Brood War map editor. It lets you write a map's triggers in TypeScript. The
files are kept inside the map.

A script can make two kinds of things:

| | `trigger()` | `program()` |
| --- | --- | --- |
| What it makes | Ordinary triggers in the map's trigger list | Code that runs inside the game |
| Plays on | Every version of StarCraft | StarCraft: Remastered only |

Each `trigger()` call records one trigger. The code around the calls runs when the script
is applied, so loops, helpers, arrays and classes can write many triggers at once.

Code inside `program(() => { … })` runs in the game. It has variables, arrays, text,
functions, classes, loops, `sleep` and `await`. TrigScript builds programs into the map
when you save. The build takes under a second and needs nothing else installed.

The code is checked as you type against the open map. `locations.`, `units.`, `switches.`
and `players.` complete to what the map has, and a location passed where a unit type
belongs is a type error.

## Documentation

The guides are on the scmJS documentation site:

| Guide | What is in it |
| --- | --- |
| [TrigScript](https://docs.scmjs.dev/trigscript/) | A quick start, triggers and programs, examples, Simulate and tests, the workspace, troubleshooting |
| [TrigScript language](https://docs.scmjs.dev/trigscript-language/) | Everything a program can use, and where it differs from TypeScript |
| [TrigScript library](https://docs.scmjs.dev/trigscript-library/) | The standard library's modules, and libraries from other plugins |
| [Coming from eudplib](https://docs.scmjs.dev/trigscript/coming-from-eudplib/) | eudplib and epScript ideas mapped to TrigScript, for map makers who use euddraft |

Their sources are `docs/trigscript.md`, `docs/trigscript-language.md` and
`docs/trigscript-library.md` in [scm-js/scm-js](https://github.com/scm-js/scm-js). Changes
to the guides go there. The editor's tests compile every example in them against the
TrigScript version the editor ships.

## Install

TrigScript ships with scmJS and is on from the start. **Triggers ▸ TrigScript…** is there
as soon as a map is open. To turn it off, use **Plugins ▸ Manage Plugins…**.

To run a different version or a fork, paste the repository's address into **Plugins ▸
Manage Plugins…** and press **Add**:

```
https://github.com/scm-js/plugin-trigscript
```

To pin a version, add a tag: `github:scm-js/plugin-trigscript@v4.5.0`.

The first time the TrigScript window opens, it downloads the code editor (Monaco),
TypeScript and the standard library's declarations from jsDelivr. So it needs an internet
connection once. The browser caches them, and the desktop app uses that cache when it is
offline.

## Getting started

**Triggers ▸ TrigScript…** opens the map's script in a window laid out like VS Code, with
the same keys. **Triggers ▸ TrigScript beside the map** opens it in a panel over the map
instead. The script starts in `main.ts`.

This trigger makes Player 1 win when a unit reaches a location named `Beacon`:

```ts
trigger(P1, [
  bring(P1, units.AnyUnit, locations.Beacon, ">=", 1),
], [
  displayText("You found the beacon."),
  victory(),
]);
```

The buttons right of the tabs run the script:

| Button | Key | What it does |
| --- | --- | --- |
| **Apply** | Ctrl+Shift+B | Puts the script's triggers into the map's trigger list, without saving |
| **Play** | F5 | Applies the script, builds the map as Save would, and starts it with Test Map |
| **Simulate** | Ctrl+F5 | Runs the script for 20 seconds of game time in a simulator built into the editor |

The panel under the code (Ctrl+J) has **Problems**, **Output**, **Simulate**, **Test
Results** and **Settings**. F1 opens the command palette.

Edits are saved into the map as you type, and Ctrl+S saves the map from the TrigScript
window too. The [workspace guide](https://docs.scmjs.dev/trigscript/the-workspace/) describes
the window in full.

### Saving

Saving the map applies the script. So do **Tools ▸ Test Map** and any export:

1. The script runs.
2. Its `trigger()` records go into the trigger list as one block. The block replaces the
   one from the last apply, or is added at the end the first time.
3. Its programs are built into the file being written.

The map you keep editing does not hold the build's output. If the script has an error, the
map is still saved with the triggers from the last script that compiled, and a notice
names the file and line.

The Trigger Editor shows the script's triggers with a `script` badge and does not let you
edit them. If one is edited some other way, the block becomes *stale*, and saving stops
applying the script until you choose **Apply** or **Append instead**. **Import the Map's
Triggers** (under **…**) turns the map's hand-made triggers into script. See [Triggers
edited by hand](https://docs.scmjs.dev/trigscript/the-workspace/#triggers-edited-by-hand).

If a script uses something TrigScript cannot build yet, its programs are not built.
Problems marks the line, and the save's notice offers to save without the programs.

The script's files live in the map archive under `trigscript\` (`trigscript\main.ts`,
`trigscript\build.json` and so on), so they travel with the `.scx`. The Save dialog lists
them with a tick each, so a copy for release can leave the source out.

### Simulate and tests

**Simulate** runs the script for 480 frames, which is 20 seconds at Fastest. It lists each
action with its frame and source line, and each program variable's final value. It also
lists the mistakes the game ignores, such as a read past the end of an array.

The simulator starts from the map's placed units, locations and players. Nothing in it
walks, fights or is built over time, so no unit dies unless the script or a test kills it.

A script can carry its own tests. They use [Vitest](https://vitest.dev)'s names, imported
from `"trigscript"`, and run in the simulator after every change that compiles. They never
run in the game and add nothing to the map. Put them in a file whose name ends in
`.test.ts`, or beside the code they test.

```ts
import { test, expect, program, createUnit, killUnitAt, countUnits, print, sleep, frames, P1, P2, units, locations } from "trigscript";

// A Marine on the beacon calls the next wave, each bigger than the last.
program(() => {
  let wave = 0;
  while (true) {
    if (countUnits(P1, units.TerranMarine, locations.Beacon) > 0) {
      wave += 1;
      createUnit(P2, units.ZergZergling, wave * 4, locations.Spawn);
      print(`Wave ${wave}`);
      killUnitAt(P1, units.TerranMarine, "All", locations.Beacon);
    }
    sleep(frames(1));
  }
}, { name: "waves" });

test("the second wave is bigger", (sim) => {
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.until(() => sim.program("waves").wave === 1);
  sim.place(P1, units.TerranMarine, locations.Beacon);
  sim.until(() => sim.program("waves").wave === 2);
  expect(sim.count(P2, units.ZergZergling, locations.Spawn)).toBe(12);
  expect(sim).toHavePrinted("Wave 2");
});
```

Each test gets `sim`, a fresh copy of the simulated world:

| `sim.` | |
| --- | --- |
| `place(player, type, at, count?)`, `kill(unit, by?)`, `remove(unit)`, `give(unit, to)`, `move(unit, to)` | Change the world. `place` returns the units it made. |
| `frames(n)`, `seconds(n)`, `until(() => …, most?)`, `frame` | Let time pass. `until` fails the test if `most` frames (2400 by default) pass first. |
| `press(key)`, `click(button)`, `type(line)`, `moveMouse(x, y)` | Act as a player. A player may be given as the last argument. |
| `count(player, type, at?)`, `units(filter?)`, `resources(player)`, `deaths(player, type)`, `kills(player, type)`, `switch(n)`, `location(n)` | Read the world. |
| `program(name?, player?)` | A program's variables, by their names in the source. |
| `printed(player?)`, `events`, `faults` | What was shown, everything that happened, and what went wrong. |

`expect` has `toBe`, `toEqual`, `not`, `toBeTruthy` / `toBeFalsy`, `toBeNull`,
`toBeDefined` / `toBeUndefined`, the four comparisons, `toContain`, `toHaveLength`,
`toMatch` and `toThrow`. It also has `expect(sim).toHavePrinted(text)` and
`expect(sim).toHaveFaulted(/pattern/)`. A fault the test did not expect fails it.

`random()` is seeded the same for every test; `sim.seed(n)` changes that. On a map with no
player settings, the world has one player, and `test(name, { as: P2 }, (sim) => { … })`
picks which.

With **Settings ▸ Tests ▸ A failing test refuses the build** on, a failing test stops
Save, Test Map and exports from applying the script. The [Testing and
Simulate](https://docs.scmjs.dev/trigscript/testing-and-simulate/) guide has more.

## Upgrading an older script

A script from an older version builds into the same map. These are the changes that can
affect one, by the version that made them.

**4.0.** Programs no longer need eudplib. TrigScript builds them itself when you save. The
eudplib plugin is no longer required, and a map that used it keeps working.

**3.10.** Test (F5) is now Play (F5), because "test" now means the script's own tests.

**3.9.** A `forEach` whose function only made actions used to build into nothing, and now
works. A function handed a text written in the script (`say("hello")`) is now compiled
once and called, where it used to be copied into each call. What it shows is the same.

**3.5.** A `number` is signed. Before, a program's numbers stopped at zero, so `3 - 10`
stored 0. Now it is −7.

- A value that relied on stopping at 0 now goes below it. Declare it a `u8` or `u16`, which
  still stop (`let lives: u8 = 3`), or write `Math.max(lives - 1, 0)`.
- A constant above 2,147,483,647 in a plain variable is an error. Declare the variable a
  `u32`.
- `/` rounds towards zero, and `%` takes the sign of the number divided.
- `>>>` is its own operator, and `>>` of a negative number keeps its sign.

**3.4.** `sleep(frames(1))` continues on the next frame. Before, the built map waited one
frame longer than asked after every `sleep`, so a script that relied on that runs a little
faster.

**3.3.** `Unit` now means a unit on the map, and a unit type is a `UnitType`. Change
annotations such as `(u: Unit) => createUnit(P1, u, 1, at)` to `u: UnitType`.
`units.AnyUnit`, `units.Men`, `units.Buildings` and `units.Factories` were off by one
before. Build the script again to fix a map made with them.

**3.0.** The old way of building programs, which ran on every version of the game, was
removed.

- A map with a `program()` needs StarCraft: Remastered. `trigger()` is unchanged.
- There is no Build button, no target switch and no `-eud.scx` file. Saving builds.
- A game loop needs a `sleep()`. `while (true) { … }` alone is an error that says where to
  put `sleep(frames(1))`.
- `sleep(seconds(n))` is 24 frames a second, and `cycles(n)` means frames.
- The `comments` and `variableUnits` options of `program()` are gone.
- The first Apply of a 2.x map replaces its block with the script's `trigger()` records
  alone.

For a map that must run programs on 1.16.1, install version 2.6.1:
`github:scm-js/plugin-trigscript@v2.6.1`.

## For other plugins

### Commands

Another plugin can use the script through `api.commands.run`. Plugins start in no fixed
order, so check `api.commands.has` first, or listen for the `"commands"` event. A `source`
argument is either the text of `main.ts` or an object of every file by path.

| Command | Returns or does |
| --- | --- |
| `trigscript.state()` | `{ files, source, manifest, block, stale, edited, unbuilt, programs, libraries }`. `block` is where the script's triggers sit, or null when they were edited by hand. `programs` is how many programs the last apply had; any at all means the saved map needs Remastered. Null with no map. |
| `trigscript.declarations({ compact? })` | The generated `.d.ts` the script is checked against. `compact` is a shorter version for a language model. |
| `trigscript.compile(source)` | A promise of a `CompileResult`: `ok`, `diagnostics`, the `trigger()` records and their source lines, the `programs` and their `variables`, the programs as IR, and `refs`, every `locations.X` / `switches.X` the files mention. A newer compile cancels an unfinished one, which rejects with `CompileSuperseded`. |
| `trigscript.build(source, { takeOver?, replaceStale? })` | Apply: compile, and if there are no errors write the block and store the files. Resolves to `{ compiled, block, refused?, replaced? }`. `refused` is `"errors"`, `"closed"`, `"switched"` or `"changed"`. `replaceStale` replaces a stale block, and `takeOver` replaces the whole trigger list. Not undoable. |
| `trigscript.print(triggers, { imports?, header? })` | Trigger records written as `trigger()` calls. |
| `trigscript.simulate(triggers, cycles, { player? })` | `{ cycles, events, switches }` from the trigger interpreter. |
| `trigscript.libraries()` | Each library the map keeps a copy of or a plugin provides: `{ id, label, version, provided, update }`. |
| `trigscript.updateLibraries(ids?)` | Replaces the map's copies of these libraries (by default, all with a newer version) and returns the ids it updated. |
| `trigscript.triggerAt(file, line)` | The index of the trigger a source line made, or null. |
| `trigscript.open({ file?, line? })` | Opens the TrigScript window at a file and line. |

The scmjs.dev plugin's *Write Triggers…* uses these.

### Building with TrigScript

A plugin that needs code in the map can write it as TrigScript programs and hand them to
TrigScript's build. The service is `trigscript.build`. Its types are in `contract.d.ts` in
this repository; copy it and import it with `import type`.

```typescript
import type { TrigScriptBuildService } from "./vendor/trigscript";
api.services.watch<TrigScriptBuildService>("trigscript.build", (build) => {
  mine?.dispose();
  mine = build?.contribute({
    id: "magenta", label: "Magenta",
    applies: () => rowsNeedingCode() > 0,
    collect: async () => ({ files: { "magenta/main.ts": renderRows() }, entries: ["magenta/main.ts"] }),
  }) ?? null;
});
```

On Save, Test Map and exports, TrigScript compiles every contribution with the map's own
script and builds all the programs into the saved map at once. Contributed programs come
after the script's.

- The files go under a folder named after the plugin, so they cannot replace the map's
  own. They are never stored in the map archive.
- A contribution may hold only programs. A `trigger()` in one fails the build.
- `check(files, entries)` compiles the files against the open map without building, and
  returns the problems and how many programs there are.
- `onBuild` reports how each build went. On a failure, `from` names the contribution.

Magenta builds its rows this way.

### Providing a library

A plugin can give scripts a library to import. See [Libraries from other
plugins](https://docs.scmjs.dev/trigscript-library/libraries-from-other-plugins/) for how
map makers use one. A plugin provides one through version 2 or later of the same service:

```typescript
api.services.watch<TrigScriptBuildService>("trigscript.build", (build, info) => {
  held?.dispose();
  held = build && (info?.version ?? 1) >= 2
    ? build.provideLibrary({ id: "waves", label: "Waves", version: "1.0.0", modules: { "index.ts": INDEX, "spawn.ts": SPAWN } })
    : null;
});
```

- The id is what scripts import the library by. It uses lower-case letters, digits and
  `-`, and starts with a letter. `trigscript` is taken. A second library with the same id
  replaces the first.
- A module's name ends in `.ts` (or `.tsx` for JSX) and may include folders
  (`ai/waves.ts`). It imports the library's other modules by relative path (`./spawn`),
  other libraries by id, and `"trigscript"` and the standard library as a script does.
  Test files are refused.
- The version is shown beside the map's copy. Change it with every release, so maps with
  an older copy are offered the update.

A plugin cannot import a `.ts` file as text, so the modules are passed as strings.
[`examples/library`](examples/library) is a complete library plugin to copy. Its TrigScript
is in `lib/`, `node embed.mjs` writes it into `modules.ts`, and `plugin.ts` provides it. It
installs as it is from `github:scm-js/plugin-trigscript/examples/library`.

## In other editors

The command line's `scmjs lsp` serves the same checks to editors other than the
TrigScript window: VS Code, Neovim, Helix and any editor with a Language Server Protocol
client. Unpack a map with `scmjs map unpack`, open its `trigscript/` folder, and the
errors, completions, hovers and go to definition are the ones the window has, against
that map's names. The command line guide's
[TrigScript in your text editor](https://docs.scmjs.dev/cli/for-developers/#trigscript-in-your-text-editor)
has the setup for each editor. `editors/vscode/` is a small VS Code extension that starts
the server.

The language behind it is `language.ts`, `ScriptLanguage`: a TypeScript language service
over the script laid out as the compiler lays it out, with the compiler's check for the
errors. It takes TypeScript as an argument and touches no files, so anything that can hand
it the script's files and the map's names can use it.

## Development

```sh
npm install
npm run typecheck   # tsc over the plugin and its tests, against @scm-js/plugin-api
npm test            # vitest
npm run build       # dist/plugin.js, dist/compiler.js, dist/testing.js and the rest
npm run bundle      # Monaco and lib.d.ts into dist/
```

The main parts:

| | |
| --- | --- |
| `plugin.ts` | Activation: the menu items, the claim on the generated block, the commands. |
| `service.ts` | What the plugin does to the map: applying the script, and its part in saving. |
| `editor.ts` | The TrigScript window, with Monaco. |
| `tree.ts` | Files as folders, and moves that rewrite imports. |
| `testState.ts` | What the window shows of the test results. |
| `monaco.ts` | Loads Monaco from `dist/` on jsDelivr, at the tag `DIST_TAG` names. |
| `language.ts` | The language for other editors: errors, completions, hovers, definitions and outlines as plain data, for `scmjs lsp`. |
| `compile.ts` | Compiles in a worker, so an endless loop in a script can be stopped. |
| `script.ts` | The files, the block and its manifest: hashing, finding the block, staleness. |
| `ko.ts`, `i18n.ts` | The Korean translation of the window. `tests/ko.test.ts` keeps it in step with the source. |
| `compiler/` | The language: the generated declarations, the runtime, the compiler, the simulators, and in `backend/` the build of the programs into a map. [`docs/compiler.md`](docs/compiler.md) walks through it and [`docs/ir.md`](docs/ir.md) describes the IR. |
| `vendor/` | Tables copied from the editor: the trigger record layout, the condition and action definitions, unit and flag names, the text trigger format. Copy them again when the editor changes them. |
| `tests/` | vitest. `readme.test.ts` compiles every `ts` example in this file and runs its tests. |

Some notes for working on it:

- To load Monaco from a local server while developing, set the browser's
  `scmjs.plugin.trigscript.monacoDist` storage key to, for example,
  `"http://localhost:3000/dist"`.
- After a Monaco update, run `npm run bundle`, commit `dist/`, tag
  `monaco-<version>-<n>`, and move `DIST_TAG` in `monaco.ts` to the new tag.
- Commit `dist/plugin.js` and `dist/compiler.js` before tagging a release. The copy of
  TrigScript compiled into the editor loads `dist/compiler.js` for its compile worker.
- `dist/testing.js` is for other repositories' tests. It parses and runs trigger text, and
  compiles a script. Add a devDependency on a tag's tarball
  (`https://github.com/scm-js/plugin-trigscript/archive/refs/tags/v4.5.0.tar.gz`), then
  `import { parseTriggers, Simulation } from "scmjs-plugin-trigscript/testing"`.
- Copies of Blizzard's maps in `fixtures/maps/` (gitignored) let the tests check that every
  trigger turns into script and back into the same record.
