import { parseRecipe } from '@101/connect';
import type { AuthorizationRequest } from '@101/connect';
import { createSensorFeedbackPipeline } from './sensor-feedback.ts';
import { createPointerPipeline } from './pointer.ts';

/** A readable declaration. It contains no code, identity proof or owner grant. */
export const roomControlRecipe = parseRecipe({
  schemaVersion: 1, id: 'example:room-control', version: '1.0.0',
  resources: [
    { id: 'sensor', direction: 'source', semantic: 'example:temperature', schemaVersion: 1, required: true },
    { id: 'relay', direction: 'sink', semantic: 'example:relay-state', schemaVersion: 1, required: true },
  ],
  processors: [{ id: 'threshold', manifest: { id: 'example:temperature-threshold', version: '1.0.0',
    codeSha256: 'dc9b34b2d209afe0b8a1d533db681de4a927003e578bde9f98d90d10db977793' },
  configuration: { onAt: 30, offAt: 28 } }],
  routes: [
    { id: 'measure', from: { node: 'sensor', port: 'value' }, to: { node: 'threshold', port: 'temperature' }, required: true },
    { id: 'actuate', from: { node: 'threshold', port: 'switch' }, to: { node: 'relay', port: 'value' }, required: true },
  ],
  permissions: [
    { route: 'measure', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Read room temperature' },
    { route: 'actuate', side: 'to', operation: 'invoke', owner: 'required', purpose: 'Set the selected relay' },
  ],
  styles: [{ id: 'default', tone: 'normal', density: 'comfortable' },
    { id: 'muted', tone: 'muted', density: 'compact' }],
  surfaces: [{ id: 'room', title: 'Room', components: [
    { id: 'heading', kind: 'text', text: 'Room controls', style: 'default' },
    { id: 'reading', kind: 'value', label: 'Temperature', from: { node: 'sensor', port: 'value' }, style: 'muted' },
    { id: 'switch', kind: 'action', label: 'Set relay', route: 'actuate', style: 'default' },
  ] }],
});

export const pointerRecipe = parseRecipe({
  schemaVersion: 1, id: 'example:pointer-view', version: '1.0.0',
  resources: [
    { id: 'touch', direction: 'source', semantic: 'example:absolute-pointer', schemaVersion: 1, required: true },
    { id: 'surface', direction: 'sink', semantic: 'example:absolute-pointer', schemaVersion: 1, required: true },
  ],
  processors: [],
  routes: [{ id: 'position', from: { node: 'touch', port: 'value' }, to: { node: 'surface', port: 'value' }, required: true }],
  permissions: [
    { route: 'position', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Read selected touch position' },
    { route: 'position', side: 'to', operation: 'write', owner: 'required', purpose: 'Move this application pointer' },
  ],
  styles: [{ id: 'default', tone: 'normal', density: 'comfortable' }],
  surfaces: [{ id: 'pointer', title: 'Pointer', components: [
    { id: 'heading', kind: 'text', text: 'Application pointer', style: 'default' },
    { id: 'position', kind: 'value', label: 'Position', from: { node: 'touch', port: 'value' }, style: 'default' },
  ] }],
});

export function runDirectRecipeExample() {
  const operations = pointerRecipe.permissions;
  const pipeline = createPointerPipeline({ authorize(request) {
    const selected = request.principalId === 'first-owner' && request.applicationId === 'pointer-example' &&
      request.sessionId === 'embedded-demo' && request.source.deviceId === 'demo-touch-surface' &&
      request.source.capabilityId === 'position' && request.sink.deviceId === 'demo-application-surface' &&
      request.sink.capabilityId === 'position' &&
      request.sourceOperation === operations.find(item => item.route === 'position' && item.side === 'from')?.operation &&
      request.sinkOperation === operations.find(item => item.route === 'position' && item.side === 'to')?.operation;
    return selected ? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 60 } : undefined;
  } });
  try {
    if (!pipeline.start.ok) throw new Error('Selected pointer recipe route did not start');
    const admitted = pipeline.publish({ x: 0.2, y: 0.8 });
    if (!admitted.ok || admitted.value.accepted !== 1) throw new Error('Selected pointer recipe input was not admitted');
    pipeline.runtime.flush();
    const position = pipeline.state().position;
    pipeline.connection.stop('example-done');
    return { recipeId: pointerRecipe.id, position, released: pipeline.state().released };
  } finally { pipeline.runtime.close(); }
}

/** This known host binds the recipe to a pinned local simulator; generic resolution is E03. */
export function runRecipeExample() {
  const processor = roomControlRecipe.processors[0];
  if (!processor || processor.manifest.codeSha256 !==
      'dc9b34b2d209afe0b8a1d533db681de4a927003e578bde9f98d90d10db977793' ||
      processor.configuration.onAt !== 30 || processor.configuration.offAt !== 28)
    throw new Error('The local simulator does not implement the selected processor pin/configuration');
  const permission = (route: string, side: 'from' | 'to') => roomControlRecipe.permissions
    .find(item => item.route === route && item.side === side)?.operation;
  const allowed = (request: Readonly<AuthorizationRequest>) => {
    if (request.principalId !== 'example-owner' || request.applicationId !== 'sensor-example' ||
        request.sessionId !== 'embedded-demo') return false;
    return request.source.deviceId === 'demo-thermometer' && request.source.capabilityId === 'temperature' &&
      request.sink.deviceId === 'temperature-threshold' && request.sink.capabilityId === 'temperature-input' &&
      request.sourceOperation === permission('measure', 'from') && request.sinkOperation === 'write' ||
      request.source.deviceId === 'temperature-threshold' && request.source.capabilityId === 'relay-state' &&
      request.sink.deviceId === 'simulated-relay' && request.sink.capabilityId === 'set-state' &&
      request.sourceOperation === 'subscribe' && request.sinkOperation === permission('actuate', 'to');
  };
  const pipeline = createSensorFeedbackPipeline({ authorize(request) {
    return allowed(request) ? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 } : undefined;
  } });
  try {
    if (!pipeline.inputStart.ok || !pipeline.outputStart.ok) throw new Error('Selected local recipe routes did not start');
    const admitted = pipeline.publishTemperature(31.25);
    if (!admitted.ok || admitted.value.accepted !== 1) throw new Error('Selected local recipe input was not admitted');
    pipeline.runtime.flush(); pipeline.runtime.flush(); pipeline.receiveFeedback();
    return { recipeId: roomControlRecipe.id, surface: roomControlRecipe.surfaces[0]?.id,
      commands: pipeline.state().commands.length, observed: pipeline.state().operations.some(item => item.state === 'observed') };
  } finally { pipeline.runtime.close(); }
}
