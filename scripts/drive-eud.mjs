// Headless proof of the Remastered target: the editor at 5173 with TrigScript served from scripts/serve.mjs (3131) and the
// eudplib plugin served from its own checkout (3132), a fixture map dropped in, the spike script pasted, the target switched,
// Build & Test pressed, the library's install dialog accepted, the -eud.scx download checked. Playwright and the headless
// shell come from the environment (see the scm-js headless recipe).
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const map = process.argv[2] ?? "/home/jeany/github/plugin-trigscript/fixtures/maps/(2)Binary Burghs.scx";
const editorUrl = process.env.EDITOR_URL ?? "http://localhost:5173";
const t0 = Date.now(); const lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || /trigscript|eudplib|requires/i.test(m.text())) logs.push(`${m.type()}: ${m.text().slice(0, 240)}`); });
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) logs.push(`${r.status()} ${r.url()}`); });
page.on("requestfailed", (r) => logs.push(`failed ${r.url()} ${r.failure()?.errorText}`));
await page.addInitScript(() => {
  localStorage.setItem("scmjs.plugins", JSON.stringify([{ spec: "github:scm-js/plugin-trigscript", enabled: false }, { spec: "http://localhost:3132/", enabled: true }, { spec: "http://localhost:3131/", enabled: true }]));
  // The eudplib plugin is loaded as a blob module by the editor, so it cannot tell it is served locally: point its runtime at the local checkout.
  localStorage.setItem("scmjs.plugin.eudplib.runtimeBase", JSON.stringify("http://localhost:3132/"));
  delete window.showSaveFilePicker; delete window.showOpenFilePicker;
});
await page.goto(`${editorUrl}/?nosplash`);
await page.waitForTimeout(6000);
lap("editor up");
const b64 = readFileSync(map).toString("base64");
const dt = await page.evaluateHandle(({ b64, name }) => { const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([arr], name)); return dt; }, { b64, name: map.split("/").pop() });
await page.dispatchEvent(".app", "drop", { dataTransfer: dt });
await page.waitForTimeout(3000);
// Open the workspace through the Triggers menu.
const menu = page.locator('button:has-text("Triggers"), [role="menuitem"]:has-text("Triggers")').first();
await menu.click();
await page.waitForTimeout(600);
await page.getByText("TrigScript…", { exact: true }).first().click();
await page.waitForTimeout(12000); // Monaco and TypeScript from the CDN.
lap("workspace open; select present: " + await page.locator("select.tsd-target").count());
lap("script comes with the map (scripts/with-script.mts)");
await page.waitForTimeout(2500);
await page.locator("select.tsd-target").selectOption("remastered");
await page.waitForTimeout(2500);
const status1 = await page.locator(".tsd .status-line, .tsd [class*=status]").last().innerText().catch(() => "");
lap("target switched; status: " + status1.slice(0, 160));
lap("library line: " + await page.locator(".tsd-library").innerText().catch(() => "?"));
const downloadP = page.waitForEvent("download", { timeout: 240000 }).catch((e) => { console.log("no download: " + e.message); return null; });
await page.getByRole("button", { name: "Build & Test" }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "eud-1.png" });
const install = page.getByRole("button", { name: "Install", exact: true });
if (await install.count()) { lap("install dialog: " + (await page.locator('[role="dialog"]').last().innerText()).replace(/\n+/g, " | ").slice(0, 300)); await install.click(); lap("install clicked"); }
else lap("no install dialog (runtime already there?)");
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(4000);
  const txt = await page.locator(".tsd").innerText().catch(() => "");
  const line = txt.split("\n").filter((l) => /Built|failed|Building|KB|Remastered build|not/i.test(l)).slice(-3).join(" | ");
  lap(line.slice(0, 220));
  if (/Built .*-eud\.scx|failed|not saved/.test(txt)) break;
  if (/Not built/.test(txt)) { console.log("problems:", (await page.locator(".tsd-problems").innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 800)); console.log("editor text head:", (await page.locator(".tsd-host").innerText().catch(() => "")).slice(0, 300).replace(/\n/g, "⏎")); break; }
}
await page.screenshot({ path: "eud-2.png" });
const fold = await page.locator(".tsd-eud").innerText().catch(() => "");
console.log("fold:", fold.replace(/\n+/g, " | ").slice(0, 600));
const dl = await downloadP;
if (dl) { const p = "eud-out.scx"; await dl.saveAs(p); console.log("downloaded", dl.suggestedFilename(), readFileSync(p).length, "bytes"); }
console.log(JSON.stringify(logs.slice(0, 30), null, 1));
await browser.close();
