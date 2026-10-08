import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

// Execute the real TSX handlers; only React state and the unavailable Expo bridge are replaced.
// This proves callback ownership, not native camera or OS permission behavior.
async function appScanner() {
  const source = readFileSync(process.env.SCANNER_OLD_APP_PATH ?? new URL('../App.tsx', import.meta.url), 'utf8');
  const syntax = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map<string, string>();
  let effect: string | undefined, oldBackground: string | undefined;
  let cancel: string | undefined, requestClose: string | undefined, barcode: string | undefined, navigate: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer.getText(syntax));
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'useEffect') {
      const callback = node.arguments[0]?.getText(syntax);
      if (callback?.includes('scannerSession') && callback.includes('addEventListener')) effect = callback;
    }
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'AppState.addEventListener') {
      const callback = node.arguments[1]?.getText(syntax);
      if (callback?.includes('setAppActive')) oldBackground = callback;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map(attribute =>
        [attribute.name.getText(syntax), attribute.initializer]));
      const handler = (name: string) => {
        const attribute = attributes.get(name);
        return attribute && ts.isJsxExpression(attribute) ? attribute.expression?.getText(syntax) : undefined;
      };
      if (node.tagName.getText(syntax) === 'Modal' && handler('visible')?.includes('scannerOpen')) requestClose = handler('onRequestClose');
      if (node.tagName.getText(syntax) === 'CameraView') barcode = handler('onBarcodeScanned');
      if (node.tagName.getText(syntax) === 'Button' && attributes.get('label')?.getText(syntax) === '"Cancel"'
        && handler('palette') === 'DARK_SURFACE') cancel = handler('onPress');
      if (node.tagName.getText(syntax) === 'ConnectScreen') navigate = handler('onOpenCodeEntry');
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.ok(cancel && requestClose && barcode && navigate, 'Actual scanner controls are required');
  let resolve!: (value: { granted: boolean }) => void, reject!: (error: Error) => void;
  let permission = new Promise<{ granted: boolean }>((yes, no) => { resolve = yes; reject = no; });
  const state = { scannerOpen: false, torch: false, review: undefined as unknown, error: undefined as unknown, receives: 0, clears: 0 };
  let background: (value: string) => void = () => undefined;
  const context = createContext({
    AppState: { currentState: 'active', addEventListener: (_name: string, callback: typeof background) => {
      background = callback; return { remove() {} };
    } },
    useRef: (current: unknown) => ({ current }), useCallback: (callback: unknown) => callback,
    cameraPermission: undefined, requestCameraPermission: () => permission,
    scannerGeneration: undefined as number | undefined,
    setScannerGeneration: (value: number) => { context.scannerGeneration = value; },
    scanClaimedRef: { current: false }, pinchRef: { current: undefined },
    pairIntake: { current: { clear() { state.clears++; }, receive(input: string, source: string) {
      state.receives++; return { status: 'review', candidate: { input, source } };
    } } },
    setScannerOpen: (value: boolean) => { state.scannerOpen = value; },
    setScannerTorch: (value: boolean) => { state.torch = value; },
    setScannerZoom() {}, setScannerMessage() {}, setPairingInput() {}, setCodeEntryOpen() {},
    setPairReview: (value: unknown) => { state.review = value; }, setError: (value: unknown) => { state.error = value; },
    setAppActive() {}, setMotionEnabled() {}, setMotionReadout() {}, readoutRenderedAt: { current: 0 },
    motion: { stop() {} }, session: { setSpeakerReady() {}, releaseAll() {} },
  });
  const evaluate = (code: string) => runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, context);
  if (declarations.has('scannerSession')) {
    const helper = await import('./scanner-session.ts');
    context.createScannerSession = helper.createScannerSession;
    evaluate(`const scannerSession = ${declarations.get('scannerSession')};`);
  }
  for (const name of ['closeScanner', 'openScanner', 'acceptScan']) {
    if (declarations.has(name)) evaluate(`const ${name} = ${declarations.get(name)};`);
  }
  let cleanup: (() => void) | undefined;
  if (effect) cleanup = evaluate(`(${effect})()`) as () => void;
  else if (oldBackground) background = evaluate(`(${oldBackground})`) as typeof background;
  const captureBarcode = () => {
    const generation = `const scannerGeneration = ${JSON.stringify(context.scannerGeneration)};`;
    return evaluate(`(() => { ${generation} return (${barcode}); })()`) as (value: { data: string }) => void;
  };
  return {
    state, open: () => evaluate('openScanner()') as Promise<void>,
    grant: () => resolve({ granted: true }), deny: () => resolve({ granted: false }), reject: () => reject(Error('private native error')),
    permissionCompletion() {
      const accept = resolve, decline = reject;
      return { grant: () => accept({ granted: true }), deny: () => accept({ granted: false }), reject: () => decline(Error('retired native error')) };
    },
    freshPermission() { permission = new Promise((yes, no) => { resolve = yes; reject = no; }); },
    background() { context.AppState.currentState = 'background'; background('background'); },
    foreground() { context.AppState.currentState = 'active'; background('active'); },
    unmount() { cleanup?.(); }, cancel: () => evaluate(`(${cancel})()`),
    requestClose: () => evaluate(`(${requestClose})()`), navigate: () => evaluate(`(${navigate})()`), captureBarcode,
  };
}

for (const reason of ['background', 'unmount', 'navigate'] as const) {
  test(`actual App retires pending camera permission on ${reason}`, async () => {
    const app = await appScanner(), opening = app.open();
    app[reason](); app.grant(); await opening;
    if (reason !== 'unmount') assert.equal(app.state.scannerOpen, false);
    assert.equal(app.state.clears, 0, 'Retired permission must not clear current pairing intake');
  });
}

test('actual App catches current camera rejection and suppresses a retired rejection', async () => {
  for (const retired of [false, true]) {
    const app = await appScanner(), opening = app.open();
    const currentGuidance = app.state.error;
    if (retired) app.background();
    app.reject(); await assert.doesNotReject(opening);
    if (retired) assert.equal(app.state.error, currentGuidance);
    else assert.match(String(app.state.error), /camera|scan|paste/i);
  }
});

for (const reason of ['cancel', 'requestClose', 'background', 'unmount', 'navigate'] as const) {
  test(`actual App refuses the queued scan after ${reason}`, async () => {
    const app = await appScanner(), opening = app.open(); app.grant(); await opening;
    assert.equal(app.state.scannerOpen, true);
    const queued = app.captureBarcode(); app[reason](); queued({ data: 'valid-pairing-code' });
    assert.equal(app.state.receives, 0, 'Retired camera callback must not reach pairing intake');
    assert.equal(app.state.review, undefined);
    if (reason !== 'unmount') assert.equal(app.state.scannerOpen, false);
  });
}

test('actual App keeps old camera callbacks retired across an explicit reopening', async () => {
  const app = await appScanner(), first = app.open(); app.grant(); await first;
  const queued = app.captureBarcode(); app.cancel(); app.freshPermission();
  const second = app.open(); app.grant(); await second;
  queued({ data: 'old-code' }); assert.equal(app.state.receives, 0);
  const current = app.captureBarcode(); current({ data: 'new-code' });
  assert.equal(app.state.receives, 1); assert.equal(app.state.scannerOpen, false);
  current({ data: 'duplicate-code' }); assert.equal(app.state.receives, 1);
});

test('scanner permission denial offers recovery without mounting a camera', async () => {
  const app = await appScanner(), opening = app.open(); app.deny(); await opening;
  assert.equal(app.state.scannerOpen, false); assert.equal(app.state.clears, 0);
  assert.match(String(app.state.error), /paste/i);
});

test('scanner lifetime rejects superseded permissions and background or unmounted scans', async () => {
  const { createScannerSession } = await import('./scanner-session.ts');
  const scanner = createScannerSession();
  assert.equal(scanner.begin(true), undefined);
  scanner.mount(true);
  const first = scanner.begin(true)!, second = scanner.begin(true)!;
  assert.equal(scanner.open(first, true), false);
  assert.equal(scanner.open(second, true), true);
  assert.equal(scanner.canScan(second, false), false);
  scanner.setForeground(false); scanner.setForeground(true);
  assert.equal(scanner.open(second, true), false);
  const next = scanner.begin(true)!;
  assert.equal(scanner.open(next, true), true);
  scanner.unmount(); scanner.mount(true);
  assert.equal(scanner.canScan(next, true), false);
});


test('actual App explains a first refused camera prompt after foreground retirement', async () => {
  const app = await appScanner();
  app.state.error = 'That connection link could not be read. Scan or paste a new one.';
  const opening = app.open();
  app.background(); app.foreground(); app.deny(); await opening;
  assert.equal(app.state.scannerOpen, false, 'Retired permission must not mount a camera');
  assert.equal(app.state.clears, 0, 'Retired permission must not clear pairing intake');
  assert.match(String(app.state.error), /camera.*pairing code.*paste/i,
    'The first refused prompt must explain camera use and manual recovery without requiring another Scan');
});


test('retired refusal cannot replace manual-entry guidance or open a replacement camera', async () => {
  const app = await appScanner(), firstCompletion = app.permissionCompletion();
  const first = app.open();
  app.background(); app.foreground(); app.freshPermission();
  const second = app.open(); app.navigate();
  assert.equal(app.state.error, undefined, 'Manual entry owns its current feedback');
  firstCompletion.deny(); await first;
  assert.equal(app.state.error, undefined, 'Retired denial must not restore camera guidance');
  app.grant(); await second;
  assert.equal(app.state.scannerOpen, false);
  assert.equal(app.state.clears, 0);
});

test('inactive Scan does not replace the current pairing feedback', async () => {
  const app = await appScanner(); app.background();
  app.state.error = 'Current pairing feedback';
  await app.open();
  assert.equal(app.state.error, 'Current pairing feedback');
  assert.equal(app.state.scannerOpen, false);
});
