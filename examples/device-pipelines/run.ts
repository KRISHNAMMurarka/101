import { runPointerExample } from './pointer.ts';
import { runSensorFeedbackExample } from './sensor-feedback.ts';
import { runTelemetryBatchExample } from './telemetry-batch.ts';
import { runSpatialJointExample } from './spatial-joints.ts';
import { runMotionExample } from './motion.ts';
import { runVisionExample } from './vision.ts';
import { runRichInputExample } from './rich-input.ts';
import { runResourceDocumentExample } from './resource-documents.ts';
import { runMediaDescriptionExample } from './media-description.ts';
import { runDirectRecipeExample, runRecipeExample } from './recipe.ts';

console.log(JSON.stringify({
  pointer: runPointerExample(),
  sensorWithFeedback: runSensorFeedbackExample(),
  sensorWithoutFeedback: runSensorFeedbackExample({ feedback: false }),
  telemetryBatch: runTelemetryBatchExample(),
  spatialJoints: runSpatialJointExample(),
  motion: runMotionExample(),
  vision: runVisionExample(),
  richInput: runRichInputExample(),
  resourceDocuments: await runResourceDocumentExample(),
  mediaDescription: runMediaDescriptionExample(),
  recipe: runRecipeExample(),
  directRecipe: runDirectRecipeExample(),
}, null, 2));
