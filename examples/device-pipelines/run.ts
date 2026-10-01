import { runPointerExample } from './pointer.ts';
import { runSensorFeedbackExample } from './sensor-feedback.ts';

console.log(JSON.stringify({
  pointer: runPointerExample(),
  sensorWithFeedback: runSensorFeedbackExample(),
  sensorWithoutFeedback: runSensorFeedbackExample({ feedback: false }),
}, null, 2));
