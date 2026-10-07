import { parentPort, workerData } from 'node:worker_threads';
import { ComputeProcessorError, createComputeProcessorInterpreter } from './processor-language.ts';
import type { ComputeProcessorProgram } from './processor-language.ts';

const port = parentPort;
if (!port) throw new Error('processor-worker');
const input = workerData as { program: ComputeProcessorProgram; configuration: unknown; memoryBytes: number; maxComputeMs: number };
try {
  const processor = createComputeProcessorInterpreter(input.program, input.configuration, input.memoryBytes, input.maxComputeMs);
  port.postMessage({ kind: 'ready', ok: true });
  port.on('message', (message: { id: number; operation: 'process' | 'reset'; inputs?: unknown }) => {
    try {
      const result = message.operation === 'reset' ? processor.reset() : processor.process(message.inputs);
      // Refuse a host transfer beyond one ordinary processor frame before structured cloning it.
      if (result !== undefined && new TextEncoder().encode(JSON.stringify(result)).byteLength > 4096) throw new ComputeProcessorError('output');
      port.postMessage({ kind: 'result', id: message.id, ok: true, ...(result === undefined ? {} : { frame: result }) });
    } catch (error) {
      port.postMessage({ kind: 'result', id: message.id, ok: false,
        reason: error instanceof ComputeProcessorError ? error.reason : 'compute' });
    }
  });
} catch (error) {
  port.postMessage({ kind: 'ready', ok: false, reason: error instanceof ComputeProcessorError ? error.reason : 'compute' });
  port.close();
}
