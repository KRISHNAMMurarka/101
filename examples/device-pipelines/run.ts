import { runPointerExample } from './pointer.ts';
import { runSensorFeedbackExample } from './sensor-feedback.ts';
import { runTelemetryBatchExample } from './telemetry-batch.ts';
import { runSpatialJointExample } from './spatial-joints.ts';

console.log(JSON.stringify({
  pointer: runPointerExample(),
  sensorWithFeedback: runSensorFeedbackExample(),
  sensorWithoutFeedback: runSensorFeedbackExample({ feedback: false }),
  telemetryBatch: runTelemetryBatchExample(),
  spatialJoints: runSpatialJointExample(),
}, null, 2));
