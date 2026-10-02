import { createDeviceRuntime } from '@101/connect';
import type { Authorize, DeviceDescriptor } from '@101/connect';

interface Surface { width: number; height: number }
interface PointerOptions { width?: number; height?: number; now?: () => number; authorize?: Authorize }

const phone: DeviceDescriptor = {
  schemaVersion: 1, id: 'demo-touch-surface', label: 'Touch surface', revision: 1,
  adapter: { id: 'example:embedded-touch', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{
    id: 'position', semantic: 'example:absolute-pointer', schemaVersion: 1, kind: 'sample',
    value: { type: 'vector', components: ['x', 'y'], unit: '1', frame: 'surface-normalized', min: 0, max: 1 },
    delivery: { mode: 'latest', maxHz: 60, maxAgeMs: 1000 }, permissions: ['subscribe'],
  }],
};

const application: DeviceDescriptor = {
  schemaVersion: 1, id: 'demo-application-surface', label: 'Application pointer', revision: 1,
  adapter: { id: 'example:embedded-surface', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{
    ...phone.capabilities[0], kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' },
  }],
};

function surfaceSize(input: Surface): Surface {
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) throw new RangeError('Surface dimensions must be positive finite numbers');
  return { width: input.width, height: input.height };
}

/** Embedded application coordinates; this example does not move an OS cursor. */
export function createPointerPipeline(options: PointerOptions = {}) {
  let surface = surfaceSize({ width: options.width ?? 1000, height: options.height ?? 500 });
  let normalized: { x: number; y: number } | undefined;
  let released = 0;
  const now = options.now ?? (() => 0);
  const runtime = createDeviceRuntime({ now, clockDomain: 'embedded-demo',
    authorize: options.authorize ?? (() => ({ expiresAt: now() + 10000, maxAgeMs: 1000, maxHz: 60 })),
  });
  const source = runtime.registerSource({ device: phone, capability: 'position' });
  const sink = runtime.registerSink({ device: application, capability: 'position',
    apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      const value = observation.value;
      if (typeof value !== 'object' || !('x' in value) || !('y' in value) || typeof value.x !== 'number' || typeof value.y !== 'number')
        throw new TypeError('Expected the declared pointer coordinates');
      normalized = { x: value.x, y: value.y };
    },
    release() { normalized = undefined; released += 1; },
  });
  runtime.setReadiness(source, 'available');
  runtime.setReadiness(sink, 'available');
  const connection = runtime.route({ from: source, to: sink,
    principalId: 'first-owner', applicationId: 'pointer-example', sessionId: 'embedded-demo',
  });
  const start = connection.start();
  return {
    runtime, source, sink, connection, start,
    publish(value: unknown) { return runtime.publish(source, value); },
    resize(value: Surface) { surface = surfaceSize(value); },
    state() {
      return { position: normalized ? { x: normalized.x * surface.width, y: normalized.y * surface.height } : undefined, released };
    },
  };
}

export function runPointerExample(options: Pick<PointerOptions, 'width' | 'height'> = {}) {
  const example = createPointerPipeline(options);
  try {
    example.publish({ x: 0.2, y: 0.8 });
    example.runtime.flush();
    const position = example.state().position;
    const other = example.runtime.route({ from: example.source, to: example.sink,
      principalId: 'second-owner', applicationId: 'pointer-example', sessionId: 'embedded-demo',
    });
    const competing = other.start();
    example.connection.stop('owner-left');
    const nextOwner = other.start();
    return { kind: 'embedded-simulation', position, competing, nextOwner, released: example.state().released };
  } finally { example.runtime.close(); }
}
