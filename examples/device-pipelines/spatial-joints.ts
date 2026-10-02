import { createDeviceRuntime, createSpatialPoseConverter, parseDeviceDescriptor, parseSignalValue, snapshotJson } from '@101/connect';
import type { Authorize, DeviceDescriptor, JsonObject, ValueSchema } from '@101/connect';

const WATCH_FRAME = { id: 'example:simulated-watch-frame', origin: 'example:room', unit: 'm',
  axes: ['right', 'up', 'forward'], handedness: 'right' } as const;
const DISPLAY_FRAME = { id: 'example:mirrored-display-frame', origin: 'example:room', unit: 'cm',
  axes: ['left', 'up', 'forward'], handedness: 'left' } as const;
const WATCH_POSE: ValueSchema = { type: 'pose', frame: WATCH_FRAME, extent: 2 };
const DISPLAY_POSE: ValueSchema = { type: 'pose', frame: DISPLAY_FRAME, extent: 200 };
const WATCH_JOINTS: ValueSchema = { type: 'joints', frame: WATCH_FRAME, extent: 2,
  joints: [{ name: 'wrist' }, { name: 'index', parent: 'wrist' }], optional: ['index'] };
const DISPLAY_JOINTS: ValueSchema = { type: 'joints', frame: DISPLAY_FRAME, extent: 200,
  joints: [{ name: 'wrist' }, { name: 'index', parent: 'wrist' }], optional: ['index'] };
const converter = createSpatialPoseConverter(WATCH_POSE, DISPLAY_POSE, { decimalPlaces: 2, maxAbsoluteError: 0.01 });

function descriptor(sink: boolean): Readonly<DeviceDescriptor> {
  return parseDeviceDescriptor({ schemaVersion: 1, id: sink ? 'spatial-joint-consumer' : 'spatial-joint-source',
    label: sink ? 'Simulated display joint positions' : 'Simulated converted watch joints', revision: 1,
    adapter: { id: 'example:spatial-joints', version: '1' }, runtime: { platform: 'embedded-application' },
    capabilities: [{ id: 'joints', semantic: 'example:spatial-joints', schemaVersion: 2,
      kind: sink ? 'property' : 'sample', value: DISPLAY_JOINTS,
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: sink ? ['write'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'observe' } } : {}) }] });
}

type JointPose = { readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number } };
type JointValues = Readonly<Record<string, JointPose>>;

/** Simulated watch-style input; source and sink route only the declared display frame. */
export function createSpatialJointPipeline(options: { now?: () => number; authorize?: Authorize } = {}) {
  const now = options.now ?? (() => 0);
  const sourceDevice = descriptor(false), sinkDevice = descriptor(true);
  const scope = { principalId: 'spatial-owner', applicationId: 'spatial-joint-example', sessionId: 'embedded-spatial' };
  let joints: JointValues = Object.freeze({}), provenance: JsonObject | undefined, released = 0;
  const runtime = createDeviceRuntime({ now, clockDomain: 'embedded-spatial-clock', authorize(request) {
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.source.registrationId !== source.id || request.sink.registrationId !== sink.id ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 10000, maxAgeMs: 1000, maxHz: 10 };
  } });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'joints' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'joints', apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) {
      joints = parseSignalValue(observation.value, DISPLAY_JOINTS) as unknown as JointValues;
      provenance = observation.provenance;
    }
  }, release() { joints = Object.freeze({}); provenance = undefined; released++; } });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const connection = runtime.route({ from: source, to: sink, ...scope }), start = connection.start();
  return { runtime, source, sink, sourceDevice, sinkDevice, connection, start,
    publish(input: unknown) {
      const raw = parseSignalValue(input, WATCH_JOINTS) as unknown as JointValues;
      const output = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, converter.convert(value)]));
      const converted = parseSignalValue(output, DISPLAY_JOINTS);
      const record = snapshotJson({ simulated: true, sourceFrame: WATCH_FRAME, conversion: converter.metadata }) as JsonObject;
      return runtime.publish(source, converted, { timestamp: now(), clockDomain: runtime.clockDomain, provenance: record });
    },
    state() { return Object.freeze({ joints, provenance, released }); } };
}

export function runSpatialJointExample() {
  const pipeline = createSpatialJointPipeline({ now: () => 1000 });
  try {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const publication = pipeline.publish({ wrist: { position: { x: 1, y: 0.5, z: -1 }, orientation: identity },
      index: { position: { x: 1.2, y: 0.5, z: -1 }, orientation: identity } });
    pipeline.runtime.flush();
    return { kind: 'embedded-simulated-fixture', publication: publication.ok, ...pipeline.state() };
  } finally { pipeline.runtime.close(); }
}
