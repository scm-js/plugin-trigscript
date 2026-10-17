/**
 * A script's map played in the lifted game with nothing drawn, and the fog of war it makes read back a frame at a time
 * into pictures (TrigScript 4, S5): what a fog renderer looks like before anyone plays it. Keys can be held over spans
 * of frames, as a player would; each frame's cost is said.
 *
 *   npx tsx scripts/fog-frames.mts <script.ts> <map.scx> [--frames=120] [--keys=20-60:W,60-90:D] [--every=10]
 *     [--area=0,0,128,96] [--player=0] [--out=dir]
 *
 * Writes <out>/frame-NNNN.png (a tile 4 pixels: white lit, grey fog, black never seen) for every `every`-th frame and
 * <out>/sheet.png of them side by side. Needs a scm-sim checkout (SCM_SIM_DIR) and a scm-js one beside this
 * repository (sharp, for the pictures).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GameSim, readLocations, type GameHandle } from "../compiler/gameSim";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [script, baseMap] = args.filter((a) => !a.startsWith("--"));
if (!script || !baseMap) { console.error("usage: fog-frames.mts <script.ts> <map.scx> [--frames=N] [--keys=a-b:K,…] [--every=N] [--area=x,y,w,h] [--out=dir]"); process.exit(2); }
const frames = Number(flag("frames") ?? 120), every = Number(flag("every") ?? 10), player = Number(flag("player") ?? 0);
const [ax, ay, aw, ah] = (flag("area") ?? "0,0,128,96").split(",").map(Number);
const out = resolve(flag("out") ?? join(root, "fixtures", "fog-frames"));
const keys = (flag("keys") ?? "").split(",").filter(Boolean).map((k) => { const [span, key] = k.split(":"); const [from, to] = span.split("-").map(Number); return { from, to, key }; });
const sim = resolve(process.env.SCM_SIM_DIR ?? join(root, "..", "scm-sim"));
const from = (p: string) => import(pathToFileURL(join(sim, p)).href);
const sharp = createRequire(join(root, "..", "scm-js", "package.json"))("sharp");

const dir = mkdtempSync(join(tmpdir(), "trigscript-fog-"));
try {
  const built = join(dir, basename(script).replace(/\.tsx?$/, "") + ".scx");
  const b = spawnSync("npx", ["tsx", join(root, "scripts", "build-fixture.mts"), resolve(script), built, resolve(baseMap)], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
  if (b.status !== 0) { console.error(b.stdout.split("\n").slice(-20).join("\n"), b.stderr); process.exit(1); }
  const { Archive } = await import(pathToFileURL(join(sim, "node_modules", "mopaq", "dist", "index.mjs")).href);
  const { startExactGame } = await from("src/exact/node.ts");
  const { classicScenario, installEud, placeStrings } = await from("src/exact/eud.ts");
  const { testGame } = await from("src/exact/testGame.ts");
  const { installCost } = await from("src/exact/cost.ts");
  const chk = Archive.open(new Uint8Array(readFileSync(built))).readFile("staredit\\scenario.chk") as Uint8Array;
  const chkPath = join(dir, "scenario.chk");
  writeFileSync(chkPath, classicScenario(chk));
  const run = await startExactGame(chkPath, { game: "ums" });
  const strings = placeStrings(run.lifted, chk);
  installEud(run.lifted, strings);
  const payloadEnd = 0x191943c8 + strings.bytes;
  const cost = installCost(run.lifted);
  const handle = testGame(run.engine, run.lifted, [{ from: strings.gameTable, to: payloadEnd }], { cost, payloadEnd }) as GameHandle;
  const world = new GameSim(handle, { locations: readLocations(handle) });

  mkdirSync(out, { recursive: true });
  const shots: { frame: number; png: Buffer }[] = [];
  const tone = { "#": 255, "+": 104, ".": 4 } as Record<string, number>;
  let peak = 0, total = 0;
  for (let f = 1; f <= frames; f++) {
    for (const k of keys) if (f >= k.from && f < k.to) world.press(k.key);
    world.frames(1);
    const r = cost.report();
    const at = r.conditions.length - 1;
    const spent = at >= 0 ? r.conditions[at] + r.actions[at] : 0;
    peak = Math.max(peak, spent);
    total += spent;
    if (f % every !== 0) continue;
    const rows = world.fog(player, { x: ax, y: ay, width: aw, height: ah }) ?? [];
    const S = 4, px = Buffer.alloc(aw * S * ah * S);
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const v = tone[row[x]] ?? 0; for (let dy = 0; dy < S; dy++) px.fill(v, (y * S + dy) * aw * S + x * S, (y * S + dy) * aw * S + x * S + S); } });
    const png = await sharp(px, { raw: { width: aw * S, height: ah * S, channels: 1 } }).png().toBuffer();
    writeFileSync(join(out, `frame-${String(f).padStart(4, "0")}.png`), png);
    shots.push({ frame: f, png });
    console.log(`frame ${f}: ${spent.toLocaleString("en-US")} conditions and actions${rows.length ? "" : " (no fog read)"}`);
  }
  console.log(`${frames} frames: ${Math.round(total / frames).toLocaleString("en-US")} a frame on average, ${peak.toLocaleString("en-US")} at the most`);
  if (shots.length) {
    const cols = Math.min(4, shots.length), W = aw * 4 + 8, H = ah * 4 + 8;
    const sheet = sharp({ create: { width: cols * W, height: Math.ceil(shots.length / cols) * H, channels: 3, background: { r: 200, g: 40, b: 40 } } });
    await sheet.composite(shots.map((s, i) => ({ input: s.png, left: (i % cols) * W + 4, top: Math.floor(i / cols) * H + 4 }))).png().toFile(join(out, "sheet.png"));
    console.log(`pictures in ${out}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!existsSync(out)) process.exit(1);
