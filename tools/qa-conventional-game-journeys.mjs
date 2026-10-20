import { connectSdkFiles } from './connect-sdk-provenance.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { generateMaze, shortestPath, mazeBearing, compassLabel } from '@101/maze';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

// One attempt per game and engine. All input is native browser input; evaluate
// only reads public DOM or waits for native RAF. The source maze is a route map,
// never a substitute for the browser's state or rendered clue observations.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, `outputs/controllers/conventional-game-journeys-${new Date().toISOString().replaceAll(':', '-')}`);
const expectedBuild = process.argv[2];
assert.match(expectedBuild ?? '', /^[a-f0-9]{64}$/, 'Pass the reviewed fresh dist/server/index.js SHA256');
assert.equal(process.argv.length, 3);
mkdirSync(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const games = ['bodydodge', 'tiltdrift', 'orbitalcrew', 'shadowarena', 'spellcaster', 'swarmcommander', 'beatforge', 'slashstorm', 'gravitystack', 'echomaze'];
const walk = path => readdirSync(resolve(root, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? walk(`${path}/${entry.name}`) : [`${path}/${entry.name}`]);
const sourcePaths = [...walk('games').filter(path => !path.includes('/node_modules/') && /\.(ts|json)$/.test(path)),
  ...walk('app/components').filter(path => /\.(tsx?|css)$/.test(path)), ...connectSdkFiles(root),
  ...walk('packages/input/src'), ...walk('packages/sdk/src'), ...walk('packages/maze/src'), ...walk('packages/core/src'),
  'app/controller/Controller.tsx', 'app/globals.css', 'tools/qa-conventional-game-journeys.mjs'];
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, sha(readFileSync(resolve(root, path)))]));
const buildPaths = walk('dist').filter(path => !path.endsWith('.map'));
const buildSha256 = Object.fromEntries(buildPaths.map(path => [path, sha(readFileSync(resolve(root, path)))]));
assert.equal(buildSha256['dist/server/index.js'], expectedBuild, 'Fresh server build pin mismatch');
const manifests = Object.fromEntries(games.map(game => [game, JSON.parse(readFileSync(resolve(root, `games/${game}/input.manifest.json`)))]));
const roles = {};
for (const game of games) {
  const roleModule = await import(`../games/${game}/src/roles.ts`);
  roles[game] = Object.values(roleModule).find(Array.isArray);
  assert.ok(roles[game]);
}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), expectedBuild, sourceSha256, buildSha256,
  scope: 'One desktop 1280x800 dark real-time native-RAF journey per game in Chromium and WebKit. Actual keyboard and local role controls; natural game end, result semantics/focus and Space restart. No clock/game-state/render overrides, retries, camera, physical controller, phone or assistive-technology qualification.',
  boundsMs: { ordinaryGame: 180000, swarmcommander: 300000, echomaze: 480000, browser: 2100000 }, results: [],
  priorComplementaryEvidence: 'outputs/controllers/2026-10-16-game-control-repair/browser-final.json covers54 selected Echo/Beat controls on prior combined build6de; not substituted for current journey results.',
  cleanup: { contextsClosed: false, browsersClosed: false, serverClosed: false } };
const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
let app;
let interrupted = false;
let activeBrowser;
const interrupt = () => { interrupted = true; void activeBrowser?.close(); };
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt); process.on('SIGHUP', interrupt);
const sleepFrame = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const pulse = async (page, key, ms = 80) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); await sleepFrame(page); };
const waitText = (page, selector, pattern, timeout = 3000) => page.waitForFunction(({ selector, source }) => new RegExp(source).test(document.querySelector(selector)?.textContent ?? ''), { selector, source: pattern.source }, { timeout });
const publicSnapshot = page => page.evaluate(() => ({ text: document.body.innerText.slice(0, 14000), focus: document.activeElement?.outerHTML.slice(0, 700), visibility: document.visibilityState, url: location.href }));
async function roleButton(page, game, action, roleId) {
  const role = roles[game].find(item => (!roleId || item.id === roleId) && item.layout.layout.some(control => control.action === action && control.type === 'button'));
  assert.ok(role, `${game}: declared role button ${action}`);
  assert.ok(manifests[game].actions?.[action], `${game}: manifest action ${action}`);
  const control = role.layout.layout.find(control => control.action === action);
  await page.getByRole('button', { name: 'Show controls', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Play as' });
  if (await selector.count()) await selector.selectOption(role.id);
  const button = page.getByRole('button', { name: new RegExp(`^${control.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|\\.)`) });
  await button.focus();
  return { button, role: role.id, action, label: control.label };
}
async function closeDeck(page, field) {
  const hide = page.getByRole('button', { name: 'Hide controls', exact: true });
  if (await hide.count()) await hide.click();
  await field.focus();
}
async function controls(page, game, field, row) {
  const effect = (action, via, observation) => row.controls.push({ action, via, consumerEffectObserved: true, observation });
  if (game === 'shadowarena') {
    await pulse(page, 'KeyJ'); await waitText(page, '.shadow-event small', /^LEFT PUNCH$/); effect('combat.punchLeft', 'keyboard KeyJ', await page.locator('.shadow-event').innerText());
    const c = await roleButton(page, game, 'combat.punchRight'); await pulse(page, 'Space'); await waitText(page, '.shadow-event small', /^RIGHT PUNCH$/); effect(c.action, `local role ${c.role}/${c.label}, Space`, await page.locator('.shadow-event').innerText());
  } else if (game === 'spellcaster') {
    await pulse(page, 'KeyC'); await waitText(page, '.spell-event strong', /ARCANE CHARGE 1\/3/); effect('spell.cast.charge', 'keyboard KeyC', await page.locator('.spell-event').innerText());
    const c = await roleButton(page, game, 'spell.cast.charge'); await pulse(page, 'Space'); await waitText(page, '.spell-event strong', /ARCANE CHARGE 2\/3/); effect(c.action, `local role ${c.role}/${c.label}, Space`, await page.locator('.spell-event').innerText());
  } else if (game === 'swarmcommander') {
    await pulse(page, 'Digit2'); await waitText(page, '.swarm-event strong', /LINE FORMATION LOCKED/); effect('swarm.formation.line', 'keyboard Digit2', await page.locator('.swarm-event').innerText());
    const c = await roleButton(page, game, 'swarm.formation.wedge'); await pulse(page, 'Space'); await waitText(page, '.swarm-event strong', /WEDGE FORMATION LOCKED/); effect(c.action, `local role ${c.role}/${c.label}, Space`, await page.locator('.swarm-event').innerText());
  } else if (game === 'echomaze') {
    await pulse(page, 'KeyF'); await waitText(page, '.echo-vitals p', /FLASHLIGHT CLOSED/); effect('maze.flashlight', 'keyboard KeyF', await page.locator('.echo-vitals p').innerText());
    const c = await roleButton(page, game, 'maze.mark'); await pulse(page, 'Space'); await waitText(page, '.echo-event [role="status"]', /^1 place marked$/); effect(c.action, `local role ${c.role}/${c.label}, Space`, await page.locator('.echo-event').innerText());
  } else if (game === 'orbitalcrew') {
    await pulse(page, 'KeyR'); await waitText(page, '.orbital-alert strong', /EMERGENCY RECALL DEPLOYED/); effect('emergency', 'keyboard KeyR (also requests power1)', await page.locator('.orbital-alert').innerText());
    row.controls.push({ action: 'emergency', via: 'local emergency role', consumerEffectObserved: false, reason: 'Recall cooldown prevents immediate independent second activation; no second attempt made.' });
  } else if (game === 'tiltdrift') {
    await pulse(page, 'Space', 350); await waitText(page, '.drift-event', /BOOST BURN/); effect('boost', 'keyboard Space', await page.locator('.drift-event').innerText());
    // Driver analog brake is represented by a native range, not a button role.
    await page.getByRole('button', { name: 'Show controls', exact: true }).click();
    const brake = page.getByRole('slider', { name: /BRAKE/ });
    const before = Number(await page.locator('.drift-stats strong').nth(1).textContent());
    await brake.focus(); await page.keyboard.down('Space'); await page.waitForTimeout(700);
    const after = Number(await page.locator('.drift-stats strong').nth(1).textContent());
    assert.ok(after < before, `actual brake must reduce speed ${before} -> ${after}`); effect('brake', 'local Driver BRAKE native range held Space', { speedBefore: before, speedAfter: after });
    await page.keyboard.up('Space');
  } else if (game === 'slashstorm') {
    await pulse(page, 'Escape'); await page.getByRole('button', { name: 'Resume', exact: true }).waitFor(); effect('pause', 'keyboard Escape', 'Resume and Paused status visible');
    const c = await roleButton(page, game, 'pause', 'sword-one'); await pulse(page, 'Space'); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor(); effect(c.action, `local role ${c.role}/${c.label}, Space`, 'Pause button visible after resume');
  } else if (game === 'beatforge') {
    const before = Number(await page.locator('.beat-stats strong').nth(1).textContent());
    await page.waitForFunction(() => document.querySelector('.beat-next strong')?.textContent === 'PUNCH' && parseFloat(document.querySelector('.beat-next small')?.textContent ?? '') <= .15, null, { timeout: 5000, polling: 10 });
    await pulse(page, 'Space');
    const after = Number(await page.locator('.beat-stats strong').nth(1).textContent()); assert.ok(after > before); effect('beat.punch', 'keyboard Space timed to visible native countdown', { scoreBefore: before, scoreAfter: after });
  } else if (game === 'bodydodge') {
    const label = (await page.locator('.body-next strong').textContent()).trim();
    const key = { LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', DUCK: 'ArrowDown', JUMP: 'Space', 'ARMS UP': 'KeyE', 'LEAN LEFT': 'ArrowLeft', 'LEAN RIGHT': 'ArrowRight' }[label];
    if (key) await page.keyboard.down(key);
    await waitText(page, '.body-event', /CLEAR$/, 6000);
    if (key) await page.keyboard.up(key);
    effect(key ? `first gate ${label}` : 'first center gate', key ? `keyboard ${key}` : 'neutral conventional position', await page.locator('.body-event').innerText());
    row.controls.push({ action: 'other body controls', consumerEffectObserved: false, reason: 'No body state exposed in public HUD; this journey verifies only the first gate judgment.' });
  }
  await closeDeck(page, field);
}
async function gravityEnd(page, row, result) {
  await page.waitForFunction(() => /Ready to play/.test(document.querySelector('.gravity-statusbar')?.textContent ?? ''), null, { timeout: 10000 });
  const beforeGuide = await page.locator('.gravity-drop-guide').getAttribute('style');
  await pulse(page, 'KeyD', 400);
  const afterGuide = await page.locator('.gravity-drop-guide').getAttribute('style'); assert.notEqual(afterGuide, beforeGuide);
  row.controls.push({ action: 'placeX', via: 'keyboard KeyD', consumerEffectObserved: true, observation: { beforeGuide, afterGuide } });
  await pulse(page, 'Space'); await page.waitForFunction(() => Number(document.querySelectorAll('.gravity-stats strong')[3]?.textContent) === 1);
  row.controls.push({ action: 'drop', via: 'keyboard Space', consumerEffectObserved: true, observation: 'PIECES1 and actual dropped event' });
  const c = await roleButton(page, 'gravitystack', 'drop'); await page.waitForTimeout(400); await pulse(page, 'Space');
  await page.waitForFunction(() => Number(document.querySelectorAll('.gravity-stats strong')[3]?.textContent) === 2);
  row.controls.push({ action: c.action, via: `local role ${c.role}/${c.label}, Space`, consumerEffectObserved: true, observation: 'PIECES2' });
  await closeDeck(page, page.locator('.gravity-stage'));
  const vectorBefore = await page.locator('.gravity-vector').getAttribute('style');
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(800); await page.keyboard.up('ArrowRight');
  const vectorAfter = await page.locator('.gravity-vector').getAttribute('style'); assert.notEqual(vectorBefore, vectorAfter);
  row.controls.push({ action: 'gravity', via: 'keyboard ArrowRight', consumerEffectObserved: true, observation: { vectorBefore, vectorAfter } });
  for (let drop = 0; drop < 4 && !(await result.count()); drop++) { await pulse(page, 'Space'); await page.waitForTimeout(500); }
  await result.waitFor({ timeout: 15000 });
  row.endEvidence = await page.locator('.gravity-vitals').innerText();
}
async function echoEnd(page, row, result, deadline) {
  let floorNumber = 1, position = { x: 0, y: 0 }, steps = 0;
  row.echoFloors = [];
  while (!(await result.count()) && performance.now() < deadline) {
    const floor = generateMaze('echomaze-1', floorNumber);
    const collected = new Set(), cleared = new Set();
    const floorEvidence = { floor: floorNumber, steps: 0, healthAtStart: await page.locator('.echo-meter-health strong').textContent(), reachedEchoes: [] };
    row.echoFloors.push(floorEvidence);
    let advanced = false;
    const targets = [...floor.echoes, ...floor.fragments, floor.exit];
    for (const target of targets) {
      if (await result.count() || advanced) break;
      const route = shortestPath(floor, position, target).slice(1);
      for (const next of route) {
        assert.ok(performance.now() < deadline, 'Echo journey bound reached');
        const key = next.x > position.x ? 'ArrowRight' : next.x < position.x ? 'ArrowLeft' : next.y > position.y ? 'ArrowDown' : 'ArrowUp';
        await pulse(page, key, 65); await page.waitForTimeout(130);
        position = next; steps++; floorEvidence.steps++;
        for (const point of floor.fragments) if (point.x === next.x && point.y === next.y) collected.add(`${point.x},${point.y}`);
        for (const point of floor.echoes) if (point.x === next.x && point.y === next.y && !cleared.has(`${point.x},${point.y}`)) { cleared.add(`${point.x},${point.y}`); floorEvidence.reachedEchoes.push({ ...point, health: await page.locator('.echo-meter-health strong').textContent() }); }
        if (await result.count()) break;
        if (next.x === floor.exit.x && next.y === floor.exit.y && collected.size === floor.fragments.length) {
          await page.waitForFunction(expected => Number(document.querySelectorAll('.echo-stats strong')[2]?.textContent) === expected, floorNumber + 1, { timeout: 2000 });
          floorNumber++; position = { x: 0, y: 0 }; advanced = true; break;
        }
        const clueTarget = floor.fragments.find(point => !collected.has(`${point.x},${point.y}`)) ?? floor.exit;
        const distance = shortestPath(floor, next, clueTarget).length - 1;
        const compass = compassLabel(mazeBearing(next, clueTarget));
        await page.waitForFunction(({ distance, compass }) => {
          const clue = document.querySelector('.echo-clue'); return clue?.querySelector('strong')?.textContent === compass && Number(clue?.querySelectorAll('dd')[1]?.textContent) === distance;
        }, { distance, compass }, { timeout: 1500 });
      }
    }
    floorEvidence.healthAtEnd = await page.locator('.echo-meter-health strong').textContent();
    if (!advanced && !(await result.count())) throw new Error('Echo route exhausted before floor advance or health loss');
  }
  assert.ok(await result.count(), 'Echo must end through actual echo collisions before bound');
  row.endEvidence = { steps, floorNumber, health: await page.locator('.echo-meter-health strong').textContent() };
  row.controls.push({ action: 'maze.move', via: 'actual keyboard walking; source model route plan/public clue verified after each step', consumerEffectObserved: true, observation: row.endEvidence });
}
try {
  app = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  const origin = `http://127.0.0.1:${app.port}`; report.origin = origin;
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (interrupted) break;
    activeBrowser = await engine.launch({ headless: true });
    const watchdog = setTimeout(interrupt, report.boundsMs.browser);
    try {
      for (const game of games) {
        if (interrupted) break;
        const row = { browser: engineName, version: activeBrowser.version(), game, startedAt: new Date().toISOString(), checks: [], controls: [], errors: [], status: 'running' };
        report.results.push(row); save();
        console.error(`${engineName}/${game}: start`);
        const context = await activeBrowser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
        const page = await context.newPage(); page.setDefaultTimeout(6000);
        const began = performance.now(), bound = report.boundsMs[game] ?? report.boundsMs.ordinaryGame;
        const timer = setTimeout(() => { row.watchdogExpired = true; void context.close(); }, bound);
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          page.on('pageerror', error => row.errors.push({ name: error.name, message: error.message }));
          await page.goto(origin + `/games/${game}`);
          await page.locator('.pre-game-option').first().locator('a').focus(); await page.keyboard.press('Enter');
          await page.waitForURL(url => url.pathname === `/games/${game}/play`);
          const field = page.locator(game === 'gravitystack' ? '.gravity-stage' : 'canvas[tabindex="0"]').first();
          await field.waitFor(); await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"],.gravity-stage'));
          row.checks.push('chooser keyboard Enter starts focused conventional field');
          const result = page.getByRole('region', { name: 'Run complete', exact: true });
          try { await controls(page, game, field, row); } catch (error) {
            row.controlFailure = { message: error.message, snapshot: await publicSnapshot(page) };
            await closeDeck(page, field);
          }
          if (game === 'gravitystack') await gravityEnd(page, row, result);
          else if (game === 'echomaze') await echoEnd(page, row, result, began + bound - 10000);
          else await result.waitFor({ timeout: Math.max(1, bound - (performance.now() - began) - 10000) });
          row.naturalEndMs = performance.now() - began; row.checks.push('natural run end');
          const again = result.getByRole('button', { name: 'Play again' });
          assert.equal(await again.evaluate(element => element === document.activeElement), true, 'result owns actual keyboard focus');
          const describedBy = await again.getAttribute('aria-describedby'); assert.ok(describedBy);
          row.resultSummary = await page.locator(`[id=${JSON.stringify(describedBy)}]`).innerText();
          row.checks.push('named result region and focused restart describe actual score');
          await page.screenshot({ path: resolve(output, `${engineName}-${game}-result.png`) });
          await page.keyboard.press('Space'); await result.waitFor({ state: 'detached' });
          await page.waitForFunction(() => document.activeElement?.matches('canvas[tabindex="0"],.gravity-stage'));
          row.checks.push('native Space restarts and returns field focus');
          await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.waitForURL(origin + `/games/${game}`);
          row.checks.push('Back returns to chooser');
          assert.deepEqual(row.errors, []);
          row.status = row.controlFailure ? 'journey-pass-control-gap' : 'pass';
        } catch (error) {
          row.status = 'fail'; row.failure = { message: error.message, stack: error.stack };
          try { row.failure.snapshot = await publicSnapshot(page); await page.screenshot({ path: resolve(output, `${engineName}-${game}-failure.png`) }); } catch { /* A closed failed context may no longer yield a diagnostic image. */ }
        } finally { clearTimeout(timer); await context.close(); row.contextClosed = true; row.elapsedMs = performance.now() - began; save(); }
        console.error(`${engineName}/${game}: ${row.status} ${Math.round(row.elapsedMs)}ms`);
      }
    } finally { clearTimeout(watchdog); await activeBrowser.close(); activeBrowser = undefined; }
  }
  report.cleanup.contextsClosed = report.results.every(row => row.contextClosed);
  report.cleanup.browsersClosed = true;
} catch (error) { report.fatal = { message: error.message, stack: error.stack }; }
finally {
  if (activeBrowser) await activeBrowser.close();
  if (app) { app.server.closeAllConnections(); await new Promise((done, reject) => app.server.close(error => error ? reject(error) : done())); report.cleanup.serverClosed = true; }
  report.finishedAt = new Date().toISOString(); report.interrupted = interrupted;
  report.sourcePinsUnchanged = Object.entries(sourceSha256).every(([path, pin]) => sha(readFileSync(resolve(root, path))) === pin);
  report.buildPinsUnchanged = Object.entries(buildSha256).every(([path, pin]) => sha(readFileSync(resolve(root, path))) === pin);
  report.journeysPassed = report.results.filter(row => row.status === 'pass' || row.status === 'journey-pass-control-gap').length;
  report.allTenJourneysBothEnginesPassed = report.results.length === 20 && report.journeysPassed === 20;
  report.allDeclaredControlsQualified = false;
  report.unobservedControls = Object.fromEntries(games.map(game => [game, Object.keys({ ...manifests[game].actions, ...manifests[game].axes, ...manifests[game].vectors }).filter(action => !report.results.filter(row => row.game === game).every(row => row.controls.some(control => control.action === action && control.consumerEffectObserved)))]));
  report.pass = report.allTenJourneysBothEnginesPassed && report.sourcePinsUnchanged && report.buildPinsUnchanged && !report.fatal && !interrupted;
  save();
}
console.log(JSON.stringify({ pass: report.pass, journeysPassed: report.journeysPassed, attempted: report.results.length, cleanup: report.cleanup, report: resolve(output, 'report.json') }, null, 2));
if (!report.pass) process.exitCode = 1;
