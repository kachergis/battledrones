// Headless check of the Skillprint link (src/skillprint/): the portal build
// in the harness page (skillprint-harness.html, the portal's iframeTest.html)
// as the portal runs it, in an iframe. Plays a skirmish and checks what
// reaches the parent: GAME_START, the player's orders, gameStates and frames,
// ADJUST_GAME presets before and during the match (the enemy commander's
// knobs, and a recorded tune whose battle record still replays exactly),
// keys 1-9 forwarded to the tester, GAME_PAUSE / GAME_RESUME both ways, and
// at the end GAME_END and GAME_COMPLETE from the Finish button. Then the
// same page on its own (no parent) must report nothing. Fails on any console
// error. Saves the last frame the portal got as skillprint-frame.jpg.
// Usage: npm run build:portal && node tools/skillprint-smoke.mjs [dir=dist-portal] [--out=dir]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out="));
const OUT = outArg ? outArg.slice(6) : tmpdir();
const ROOT = resolve(args.find((a) => !a.startsWith("--")) ?? join(HERE, "../dist-portal"));
const HARNESS = join(HERE, "../skillprint-harness.html");
if (!existsSync(join(ROOT, "index.html"))) throw new Error(`no build in ${ROOT}: npm run build:portal first`);
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".jpg": "image/jpeg"
};
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = p === "/iframeTest.html" && !existsSync(join(ROOT, p)) ? HARNESS : join(ROOT, p);
  if (!existsSync(file)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(8898, r));
const base = "http://localhost:8898/";

// a Chromium: CI's, Playwright's cache, or the installed Chrome
const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
const candidates = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ...(existsSync(cache)
    ? readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()
        .flatMap((d) => [join(cache, d, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"), join(cache, d, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"), join(cache, d, "chrome-linux/chrome")])
    : [])
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : { channel: "chrome" }),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
// (a missing file names itself; the browser's own /favicon.ico ask for the harness page doesn't count)
const missing = [];
page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) missing.push(`${r.status()} ${r.url()}`); });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`  ok  ${msg}`);

const harness = (fn, arg) => page.evaluate(fn, arg);
const events = () => harness(() => window.harness.messages.filter((m) => m.type === "gameEvent").map((m) => m.data.event));
const gameFrame = () => page.frames().find((f) => /\/index\.html/.test(f.url()));

await page.goto(`${base}iframeTest.html`, { waitUntil: "networkidle" });
let game = gameFrame();
await game.evaluate(() => {
  localStorage.setItem("battledrones.settings", JSON.stringify({ mapId: "riverlands", difficulty: "normal" }));
  sessionStorage.clear();
});
await game.evaluate(() => location.reload());
await page.waitForTimeout(500);
game = gameFrame();
await game.waitForSelector("#play", { timeout: 30000 });
if (!(await game.evaluate(() => !!window.__skillprint))) fail("the bridge didn't attach in an iframe");

// an adjustment before any match: kept, and applied when one starts
await harness(() => window.harness.adjust("2"));
await harness(() => window.harness.adjust("7")); // next match: Hard
await game.click("#play");
await game.waitForSelector(".op-card", { timeout: 30000 });
if ((await events()).length) fail(`events before the battle started: ${await events()}`);
await game.locator(".op-card[data-id=blitz]").click();
await game.waitForFunction(() => window.__bd?.world?.tick > 5, null, { timeout: 30000 });
const red = await game.evaluate(() => {
  const ai = window.__bd.scene.ais.get(window.__bd.player === "blue" ? "red" : "blue");
  return { difficulty: ai.difficulty, tuning: ai.tuning, income: window.__bd.world.factions[window.__bd.player === "blue" ? "red" : "blue"].incomeMult, mine: window.__bd.world.factions[window.__bd.player].incomeMult };
});
if (red.difficulty !== "hard") fail(`aiDifficulty 2 set before the match didn't pick a Hard commander: ${red.difficulty}`);
if (red.tuning?.interval !== 3.5 || red.tuning?.assaultMult !== 1.35) fail(`preset 2 not on the commander: ${JSON.stringify(red.tuning)}`);
if (red.income !== 0.8 || red.mine !== 1.15) fail(`preset 2's incomes not applied: enemy ${red.income}, player ${red.mine}`);
else ok(`a preset sent at the menu tunes the match: ${JSON.stringify(red)}`);

// the player gives an order
await game.evaluate(() => {
  const { world: w, ctrl, player } = window.__bd;
  const ids = [...w.units.values()].filter((u) => u.faction === player && u.kind === "stinger").map((u) => u.id);
  ctrl.enqueue({ type: "attackMove", faction: player, unitIds: ids, x: w.width / 2, y: w.height / 2 });
});
await game.evaluate(() => window.__bd.scene.step(100, 60));
await page.waitForTimeout(4500); // (frames go out every 2 s of real time)
const ev1 = await events();
if (ev1[0] !== "GAME_START") fail(`first event is ${ev1[0]}, not GAME_START`);
if (!ev1.includes("ORDER")) fail("the player's order wasn't reported");
const start = await harness(() => window.harness.messages.find((m) => m.data?.event === "GAME_START").data);
if (start.map !== "riverlands" || start.opener !== "blitz" || start.difficulty !== "hard") fail(`GAME_START: ${JSON.stringify(start)}`);
else ok(`GAME_START ${JSON.stringify(start)}`);
const state = await harness(() => window.harness.state);
if (!state || typeof state.armyValue !== "number" || state.time < 5) fail(`gameState: ${JSON.stringify(state)}`);
else ok(`gameState ${JSON.stringify(state)}`);
const shots = await harness(() => window.harness.screenshots);
if (shots < 1) fail("no frames reached the parent");
else ok(`${shots} frames`);

// mid-match: preset 9 (Extreme), a key forwarded to the tester (4: Brisk), pause both ways
await harness(() => window.harness.adjust("9"));
await game.evaluate(() => window.__bd.scene.step(100, 2));
await game.locator("canvas.view3d").click({ position: { x: 600, y: 400 } }).catch(() => {});
await page.keyboard.press("4");
await page.waitForTimeout(300);
const keyed = await harness(() => window.harness.messages.some((m) => m.type === "skillprint_keydown" && m.key === "4"));
if (!keyed) fail("key 4 didn't reach the tester");
await game.evaluate(() => window.__bd.scene.step(100, 2));
const mid = await game.evaluate(() => {
  const enemy = window.__bd.player === "blue" ? "red" : "blue";
  const rec = window.__bd.scene.battleRecord();
  return {
    tuning: window.__bd.scene.ais.get(enemy).tuning,
    income: window.__bd.world.factions[enemy].incomeMult,
    tunes: rec.turns.flatMap(([t, f, cs]) => cs.filter((c) => c.type === "tune").map((c) => [t, f, c.incomeMult]))
  };
});
if (mid.tuning.interval !== 1.5 || mid.income !== 1.15) fail(`key 4 (Brisk) after preset 9 didn't land: ${JSON.stringify(mid)}`);
if (mid.tunes.length < 4) fail(`expected the tunes in the battle record: ${JSON.stringify(mid.tunes)}`);
else ok(`mid-match presets: ${JSON.stringify(mid)}`);

await harness(() => document.getElementById("game").contentWindow.postMessage({ type: "GAME_PAUSE" }, "*"));
await page.waitForTimeout(200);
if (!(await game.evaluate(() => window.__bd.ctrl.paused))) fail("GAME_PAUSE didn't pause the game");
await harness(() => document.getElementById("game").contentWindow.postMessage({ type: "GAME_RESUME" }, "*"));
await page.waitForTimeout(200);
if (await game.evaluate(() => window.__bd.ctrl.paused)) fail("GAME_RESUME didn't resume the game");
await game.evaluate(() => window.__bd.scene.step(100, 1));
const ev2 = await events();
if (!ev2.includes("GAME_PAUSE") || !ev2.includes("GAME_RESUME")) fail(`pause events: ${ev2.filter((e) => /PAUSE|RESUME/.test(e))}`);
else ok("pause and resume, both ways");

// play on a while, then the record (tunes and all) must replay exactly
await game.evaluate(() => window.__bd.scene.step(100, 600, false));
{
  const json = await game.evaluate(() => JSON.stringify(window.__bd.scene.battleRecord()));
  const file = join(tmpdir(), `skillprint-record-${process.pid}.json`);
  writeFileSync(file, json);
  const r = spawnSync("npx", ["vite-node", join(HERE, "check-record.ts"), file], { encoding: "utf8" });
  const said = `${r.stdout}${r.stderr}`.trim().split("\n").filter((l) => /RECORD/.test(l)).join(" ");
  if (r.status !== 0 || !/RECORD OK/.test(said)) fail(`the tuned battle record didn't replay: ${said || r.stderr}`);
  else ok(said);
}

// resign: GAME_END, the finale, then the end screen's Finish button
await game.evaluate(() => window.__bd.ctrl.enqueue({ type: "resign", faction: window.__bd.player }));
await game.evaluate(() => window.__bd.scene.step(100, 3));
await game.waitForFunction(() => window.__bd.scene.over, null, { timeout: 10000 });
for (let i = 0; i < 40 && !(await game.$("#skillprint-finish")); i++) await game.evaluate(() => window.__bd.scene.step(100, 10));
const ev3 = await events();
if (ev3.at(-1) !== "GAME_END") fail(`last event ${ev3.at(-1)}, not GAME_END`);
const last = await harness(() => window.harness.state);
if (!last?.isGameOver || last.outcome !== "resigned") fail(`final gameState: ${JSON.stringify(last)}`);
else ok(`final gameState ${JSON.stringify(last)}`);
const finish = await game.$("#skillprint-finish");
if (!finish) fail("no Finish button on the end screen");
else {
  await finish.click();
  await page.waitForTimeout(300);
  const done = await harness(() => window.harness.completed);
  if (!done || done.outcome !== "resigned") fail(`GAME_COMPLETE: ${JSON.stringify(done)}`);
  else ok(`GAME_COMPLETE ${JSON.stringify(done)}`);
}
const frame = await harness(() => document.getElementById("frame").src);
if (frame?.startsWith("data:image/jpeg")) writeFileSync(join(OUT, "skillprint-frame.jpg"), Buffer.from(frame.split(",")[1], "base64"));

// no parent page: nothing attaches, nothing is posted
const alone = await browser.newPage({ viewport: { width: 800, height: 600 } });
alone.on("pageerror", (e) => errors.push(String(e)));
await alone.goto(base, { waitUntil: "networkidle" });
if (await alone.evaluate(() => "__skillprint" in window)) fail("the bridge attached on a page of its own");
else ok("on its own, the game reports nothing");

if (missing.length) fail(`missing: ${JSON.stringify(missing.slice(0, 10))}`);
const real = errors.filter((e) => !/Failed to load resource/.test(e));
if (real.length) fail(`console errors: ${JSON.stringify(real.slice(0, 10))}`);
console.log(process.exitCode ? "SKILLPRINT SMOKE FAILED" : "SKILLPRINT SMOKE OK");
await browser.close();
server.close();
