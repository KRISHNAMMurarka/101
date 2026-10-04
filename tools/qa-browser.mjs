#!/usr/bin/env node
/** Repeatable production-browser checks. Run `npm run build` first. */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
if (!["layout", "keyboard", "growth", "offline", "engines"].includes(mode)) {
  console.error("Usage: node tools/qa-browser.mjs <layout|keyboard|growth|offline|engines>");
  process.exit(2);
}
if (!existsSync(join(root, "dist/server/index.js"))) {
  console.error("Build the current source first: npm run build");
  process.exit(2);
}

const viewports = [
  [240, 600], [282, 860], [320, 568], [360, 640], [390, 844], [430, 932],
  [568, 320], [667, 375], [844, 390], [768, 1024], [1024, 768],
  [1280, 800], [1440, 900], [1920, 1080],
];
const routes = pages(join(root, "app"));
routes.push("/__101_browser_qa_missing_page__");

let server;
let browser;
try {
  const baseURL = process.env.QA_BASE_URL ?? await startServer();
  browser = await chromium.launch({ headless: true });
  const failures = mode === "layout"
    ? await auditLayout(browser, baseURL)
    : mode === "growth"
      ? await auditGrowth(browser, baseURL)
      : mode === "offline"
        ? await auditOffline(browser, baseURL)
        : mode === "engines"
          ? await auditEngines(baseURL)
          : await auditKeyboard(browser, baseURL);
  console.log(`${mode}: ${failures.length ? "FAIL" : "PASS"} (${routes.length} routes${mode === "layout" ? ` × ${viewports.length} viewports` : ""})`);
  for (const failure of failures) console.error(`  ${failure}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill();
}

function pages(dir, prefix = "") {
  const found = [];
  if (existsSync(join(dir, "page.tsx"))) found.push(prefix || "/");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith("(") && !entry.name.startsWith("_")) {
      found.push(...pages(join(dir, entry.name), `${prefix}/${entry.name}`));
    }
  }
  return found;
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  server = spawn(join(root, "node_modules/.bin/vinext"), ["start"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Production server exited with ${server.exitCode}`);
    try {
      const response = await fetch(baseURL, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return baseURL;
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Production server did not start within 20 seconds");
}

async function newPage(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    colorScheme: "dark",
    isMobile: width < 900,
    hasTouch: width < 900,
  });
  const page = await context.newPage();
  return { context, page };
}

async function visit(page, baseURL, route) {
  const response = await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("body").waitFor();
  const readySelector = route === "/" || route.startsWith("/studio/catalog-bench")
    ? ".catalog-game-card"
    : /^\/games\/[^/]+\/play$/.test(route)
      ? "canvas[tabindex='0'], .gravity-stage[tabindex='0']"
      : /^\/games\/[^/]+$/.test(route)
        ? ".pre-game-question"
        : route === "/controller"
          ? ".controller-session"
          : null;
  if (readySelector) await page.locator(readySelector).first().waitFor({ timeout: 15000 });
  return response;
}

async function auditLayout(browser, baseURL) {
  const failures = [];
  for (const [width, height] of viewports) {
    const { context, page } = await newPage(browser, width, height);
    for (const route of routes) {
      try {
        const response = await visit(page, baseURL, route);
        if (!response || (response.status() !== 200 && response.status() !== 404)) {
          failures.push(`${route} ${width}×${height}: HTTP ${response?.status() ?? "none"}`);
          continue;
        }
        const result = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
          const controls = [...document.querySelectorAll("a,button,input,select,textarea,[role='button']")]
            .filter((element) => {
              const style = getComputedStyle(element);
              return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
            })
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              if (rect.height < 1 || rect.width < 1 || rect.bottom < 0 || rect.top > innerHeight) return false;
              // Offscreen focus-only controls are deliberately revealed when focused.
              if (getComputedStyle(element).clipPath !== "none") return false;
              return rect.left < -2 || rect.right > viewport + 2;
            })
            .slice(0, 4)
            .map((element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 35) || element.tagName);
          return { overflow: width - viewport, controls };
        });
        if (result.overflow > 2 || result.controls.length) {
          failures.push(`${route} ${width}×${height}: horizontal overflow ${result.overflow}px; controls ${result.controls.join(", ")}`);
        }
      } catch (error) { failures.push(`${route} ${width}×${height}: ${error.message}`); }
    }
    await context.close();
    console.log(`layout: ${width}×${height} checked`);
  }
  return failures;
}

async function auditGrowth(browser, baseURL) {
  const failures = [];
  for (const width of [390, 768, 1280]) {
    const { context, page } = await newPage(browser, width, width === 390 ? 844 : 800);
    for (const route of routes) {
      try {
        await visit(page, baseURL, route);
        // Hydration and device discovery can add a one-time panel. Measure only after
        // the layout has held still; the check is for growth that continues at rest.
        await page.evaluate(async () => {
          const dimensions = () => `${document.documentElement.scrollHeight}:${[...document.querySelectorAll("canvas")].map((canvas) => Math.round(canvas.getBoundingClientRect().height)).join(",")}`;
          let previous = dimensions();
          let stableSince = performance.now();
          const started = stableSince;
          while (performance.now() - started < 6000) {
            await new Promise(requestAnimationFrame);
            const current = dimensions();
            if (current !== previous) { previous = current; stableSince = performance.now(); }
            if (performance.now() - stableSince >= 800) return;
          }
          throw new Error("page dimensions did not settle within six seconds");
        });
        const sample = () => page.evaluate(() => ({
          page: document.documentElement.scrollHeight,
          canvases: [...document.querySelectorAll("canvas")].map((canvas) => Math.round(canvas.getBoundingClientRect().height)),
        }));
        const before = await sample();
        await page.waitForTimeout(1500);
        const after = await sample();
        if (after.page - before.page > 5 || after.canvases.some((height, index) => height - (before.canvases[index] ?? height) > 5)) {
          failures.push(`${route} ${width}px: page ${before.page}→${after.page}, canvases ${before.canvases}→${after.canvases}`);
        }
      } catch (error) { failures.push(`${route} ${width}px: ${error.message}`); }
    }
    await context.close();
    console.log(`growth: ${width}px checked`);
  }
  return failures;
}

async function auditKeyboard(browser, baseURL) {
  const failures = [];
  const { context, page } = await newPage(browser, 390, 844);
  for (const route of routes) {
    try {
      await visit(page, baseURL, route);
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        visible: document.activeElement?.matches(":focus-visible"),
      }));
      if (!focus.visible || focus.tag === "BODY") failures.push(`${route}: first Tab did not show keyboard focus`);
    } catch (error) { failures.push(`${route}: ${error.message}`); }
  }

  await visit(page, baseURL, "/");
  await page.locator("#catalog-search").focus();
  const expected = await page.locator(".catalog-game-card .game-card-launch").count();
  const visited = new Set();
  for (let step = 0; step < expected + 4; step++) {
    await page.keyboard.press("Tab");
    const game = await page.evaluate(() => document.activeElement?.closest(".catalog-game-card")?.querySelector("h3")?.textContent);
    if (game) visited.add(game);
  }
  if (visited.size !== expected) failures.push(`library: fast Tab reached ${visited.size} of ${expected} game links`);

  // Each card must lead through its real chooser into a focused play field and back again.
  // Derive game routes from their pages so the check grows with the catalog.
  for (const route of routes.filter((path) => /^\/games\/[^/]+$/.test(path))) {
    const launch = `.catalog-game-card .game-card-launch[href="${route}"]`;
    try {
      await visit(page, baseURL, "/");
      await page.locator(launch).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`${baseURL}${route}`);
      const start = page.locator(".pre-game-option").first().locator("a");
      await start.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === `${route}/play`);
      await page.waitForFunction(() => document.activeElement?.matches("canvas[tabindex='0'],.gravity-stage[tabindex='0']"), null, { timeout: 10000 });
      await page.keyboard.press("ArrowLeft");
      const back = page.locator("button.back-button");
      await back.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`${baseURL}${route}`);
    } catch (error) { failures.push(`${route}: chooser/play/back journey: ${error.message}`); }
  }
  await context.close();
  return failures;
}

async function auditOffline(browser, baseURL) {
  const failures = [];
  const controllerResponse = await fetch(`${baseURL}/controller?session=ROOM1`);
  if (controllerResponse.headers.get("referrer-policy") !== "no-referrer") failures.push("controller must suppress pairing-link referrers");
  if (controllerResponse.headers.get("x-content-type-options") !== "nosniff") failures.push("controller must disable MIME sniffing");
  if (!controllerResponse.headers.get("content-security-policy")?.includes("frame-ancestors 'none'")) failures.push("controller must reject embedding");
  const runtimeAssets = [
    ["/models/pose_landmarker_lite.task", "application/octet-stream"],
    ["/models/hand_landmarker.task", "application/octet-stream"],
    ["/mediapipe/wasm/vision_wasm_internal.js", "application/javascript"],
    ["/mediapipe/wasm/vision_wasm_internal.wasm", "application/wasm"],
    ["/mediapipe/wasm/vision_wasm_nosimd_internal.js", "application/javascript"],
    ["/mediapipe/wasm/vision_wasm_nosimd_internal.wasm", "application/wasm"],
  ];
  await Promise.all(runtimeAssets.map(async ([path, type]) => {
    const response = await fetch(`${baseURL}${path}`, { method: "HEAD" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith(type) || Number(response.headers.get("content-length")) <= 0) {
      failures.push(`${path}: missing or invalid production runtime asset (${response.status}, ${response.headers.get("content-type")})`);
    }
  }));
  const { context, page } = await newPage(browser, 390, 844);
  try {
    await visit(page, baseURL, "/controller?session=ROOM1");
    const image = await page.locator('meta[property="og:image"]').getAttribute("content");
    if (image !== `${baseURL}/og.png`) failures.push(`controller social image uses ${image} instead of the production origin`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await context.setOffline(true);
    await page.goto(`${baseURL}/controller?session=ROOM2`, { waitUntil: "domcontentloaded" });
    await page.locator(".controller-session strong").getByText("ROOM2").waitFor();
  } catch (error) { failures.push(`offline controller room reopen: ${error.message}`); }
  await context.close();
  return failures;
}

async function auditEngines(baseURL) {
  const failures = [];
  for (const [name, engine] of [["WebKit", webkit], ["Firefox", firefox]]) {
    const engineBrowser = await engine.launch({ headless: true });
    try {
      for (const [width, height] of [[390, 844], [844, 390], [1280, 800]]) {
        for (const theme of ["dark", "light"]) {
          const context = await engineBrowser.newContext({
            viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce",
            ...(name === "WebKit" && width < 900 ? { isMobile: true, hasTouch: true } : {}),
          });
          const page = await context.newPage();
          for (const route of routes) {
            try {
              await visit(page, baseURL, route);
              const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);
              if (overflow > 2) failures.push(`${name} ${theme} ${width}×${height} ${route}: ${overflow}px horizontal overflow`);
            } catch (error) { failures.push(`${name} ${theme} ${width}×${height} ${route}: ${error.message}`); }
          }
          await visit(page, baseURL, "/");
          try {
            const opener = page.getByRole("button", { name: "Try a second-screen controller" });
            await opener.click();
            await page.locator("dialog[open]").waitFor();
            await page.keyboard.press("Escape");
            await page.waitForFunction(() => document.querySelector("dialog[open]") === null);
            if (!(await opener.evaluate((element) => element === document.activeElement))) {
              failures.push(`${name} ${theme} ${width}×${height}: dialog did not return focus`);
            }
          } catch (error) { failures.push(`${name} ${theme} ${width}×${height}: dialog ${error.message}`); }
          await context.close();
          console.log(`engines: ${name} ${theme} ${width}×${height} checked`);
        }
      }
    } finally { await engineBrowser.close(); }
  }
  return failures;
}
