import { runPointerExample } from './pointer.ts';
import { runSensorFeedbackExample } from './sensor-feedback.ts';
import { runTelemetryBatchExample } from './telemetry-batch.ts';
import { runSpatialJointExample } from './spatial-joints.ts';
import { runMotionExample } from './motion.ts';
import { runVisionExample } from './vision.ts';
import { runTouchContactsExample } from './touch-contacts.ts';
import { runKeyboardTextExample } from './keyboard-text.ts';
import { runRichInputExample } from './rich-input.ts';
import { runResourceDocumentExample } from './resource-documents.ts';
import { runMediaDescriptionExample } from './media-description.ts';
import { runDirectRecipeExample, runRecipeExample } from './recipe.ts';
import { runConformanceExample } from './conformance.ts';
import { runSettingsStorageExample } from './settings-storage.ts';

console.log(JSON.stringify({
  pointer: runPointerExample(),
  sensorWithFeedback: runSensorFeedbackExample(),
  sensorWithoutFeedback: runSensorFeedbackExample({ feedback: false }),
  telemetryBatch: runTelemetryBatchExample(),
  spatialJoints: runSpatialJointExample(),
  motion: runMotionExample(),
  vision: runVisionExample(),
  richInput: runRichInputExample(),
  keyboardText: runKeyboardTextExample(),
  touchContacts: runTouchContactsExample(),
  resourceDocuments: await runResourceDocumentExample(),
  mediaDescription: runMediaDescriptionExample(),
  recipe: runRecipeExample(),
  directRecipe: runDirectRecipeExample(),
  conformance: await runConformanceExample(),
  settingsStorage: await runSettingsStorageExample(),
}, null, 2));
