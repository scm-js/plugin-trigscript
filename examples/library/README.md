# Waves: an example TrigScript library

A plugin that gives TrigScript scripts a library to import. Copy this folder to make one
of your own.

```typescript
import { announce, spawnWave, waveSize } from "waves";
```

- `lib/` is the library: TrigScript modules, each imported by `"waves/<name>"`, with
  `"waves"` alone meaning `lib/index.ts`.
- `node embed.mjs` writes `lib/` into `modules.ts` as text. Run it after every change to a
  module: a plugin cannot import a `.ts` file as text.
- `plugin.ts` hands the modules to TrigScript through its `trigscript.build` service
  (version 2 and later), and hands them again when TrigScript restarts.
- `plugin.json` requires TrigScript, so installing this installs TrigScript first.
  Raise its `version` with every release. Maps keep the copy they took, and are offered
  the newer version.

To try it, paste `github:scm-js/plugin-trigscript/examples/library` into **Plugins ▸
Manage Plugins…** and press **Add**. TrigScript's README, under *Libraries from other
plugins* and *Providing a library*, describes the rest.
