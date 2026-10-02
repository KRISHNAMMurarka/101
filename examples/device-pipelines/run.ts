import { runPointerExample } from './pointer.ts';
import { runSensorFeedbackExample } from './sensor-feedback.ts';
import { runTelemetryBatchExample } from './telemetry-batch.ts';

console.log(JSON.stringify({
  pointer: runPointerExample(),
  sensorWithFeedback: runSensorFeedbackExample(),
  sensorWithoutFeedback: runSensorFeedbackExample({ feedback: false }),
  telemetryBatch: runTelemetryBatchExample(),
}, null, 2));
