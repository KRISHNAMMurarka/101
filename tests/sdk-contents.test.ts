import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const audit = resolve(import.meta.dirname, '../tools/audit-sdk-contents.py');
const qa = resolve(import.meta.dirname, '../tools/qa-sdk-contents.mjs');
const python = process.env.ONE01_K12_SDK_PYTHON ?? 'python3';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sourceTree = '1'.repeat(40), privateFixture = 'K12_SDK_PRIVATE_FIXTURE';
const marker = '-----BEGIN PRIVATE KEY-----';

// Frozen actual7package path/metadata shape, filled during source authoring below.
// Runtime JS/declarations are deliberately inert; this is no compilation or SDK proof.
const packageShapes: readonly { name: string; version: string; files: readonly string[]; metadata: object }[] = [
  {
    "name": "@101/device-model",
    "version": "0.1.0",
    "files": [
      "dist/connector-profile.d.ts",
      "dist/connector-profile.js",
      "dist/control-surface.d.ts",
      "dist/control-surface.js",
      "dist/descriptor-schema.d.ts",
      "dist/descriptor-schema.js",
      "dist/descriptor.d.ts",
      "dist/descriptor.js",
      "dist/discovery.d.ts",
      "dist/discovery.js",
      "dist/evolution.d.ts",
      "dist/evolution.js",
      "dist/extension-release.d.ts",
      "dist/extension-release.js",
      "dist/generic-processors.d.ts",
      "dist/generic-processors.js",
      "dist/haptic-profile.d.ts",
      "dist/haptic-profile.js",
      "dist/health.d.ts",
      "dist/health.js",
      "dist/impulse-fusion.d.ts",
      "dist/impulse-fusion.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/input-details.d.ts",
      "dist/input-details.js",
      "dist/input-profile.d.ts",
      "dist/input-profile.js",
      "dist/measurement-processors.d.ts",
      "dist/measurement-processors.js",
      "dist/media.d.ts",
      "dist/media.js",
      "dist/motion-math.d.ts",
      "dist/motion-math.js",
      "dist/motion-processors.d.ts",
      "dist/motion-processors.js",
      "dist/observation-timing.d.ts",
      "dist/observation-timing.js",
      "dist/package-catalog.d.ts",
      "dist/package-catalog.js",
      "dist/pipeline-timing.d.ts",
      "dist/pipeline-timing.js",
      "dist/private-directory.d.ts",
      "dist/private-directory.js",
      "dist/processor-graph.d.ts",
      "dist/processor-graph.js",
      "dist/processor-manifest.d.ts",
      "dist/processor-manifest.js",
      "dist/quality.d.ts",
      "dist/quality.js",
      "dist/recipe-resolver.d.ts",
      "dist/recipe-resolver.js",
      "dist/recipe.d.ts",
      "dist/recipe.js",
      "dist/remote-clock.d.ts",
      "dist/remote-clock.js",
      "dist/resource.d.ts",
      "dist/resource.js",
      "dist/route-group.d.ts",
      "dist/route-group.js",
      "dist/sample.d.ts",
      "dist/sample.js",
      "dist/spatial.d.ts",
      "dist/spatial.js",
      "dist/units.d.ts",
      "dist/units.js",
      "dist/watch-companion-report.d.ts",
      "dist/watch-companion-report.js",
      "dist/workload.d.ts",
      "dist/workload.js",
      "dist/wot.d.ts",
      "dist/wot.js",
      "LICENSE",
      "package.json",
      "README.md",
      "schema/device-descriptor.json"
    ],
    "metadata": {
      "name": "@101/device-model",
      "version": "0.1.0",
      "description": "101 device-model SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        },
        "./schema/device-descriptor.json": "./schema/device-descriptor.json"
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md",
        "schema"
      ]
    }
  },
  {
    "name": "@101/device-runtime",
    "version": "0.1.0",
    "files": [
      "dist/application-snapshot.d.ts",
      "dist/application-snapshot.js",
      "dist/application-views.d.ts",
      "dist/application-views.js",
      "dist/capability-inventory.d.ts",
      "dist/capability-inventory.js",
      "dist/conformance.d.ts",
      "dist/conformance.js",
      "dist/durable-artifact-jobs.d.ts",
      "dist/durable-artifact-jobs.js",
      "dist/haptic-output.d.ts",
      "dist/haptic-output.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/input-ownership.d.ts",
      "dist/input-ownership.js",
      "dist/inspector.d.ts",
      "dist/inspector.js",
      "dist/lease.d.ts",
      "dist/lease.js",
      "dist/media-grants.d.ts",
      "dist/media-grants.js",
      "dist/media-recording.d.ts",
      "dist/media-recording.js",
      "dist/media-synchronization.d.ts",
      "dist/media-synchronization.js",
      "dist/native-discovery.d.ts",
      "dist/native-discovery.js",
      "dist/operator-health.d.ts",
      "dist/operator-health.js",
      "dist/output-sharing.d.ts",
      "dist/output-sharing.js",
      "dist/owner-backup.d.ts",
      "dist/owner-backup.js",
      "dist/owner-data-storage.d.ts",
      "dist/owner-data-storage.js",
      "dist/owner-data.d.ts",
      "dist/owner-data.js",
      "dist/package-catalog.d.ts",
      "dist/package-catalog.js",
      "dist/placement.d.ts",
      "dist/placement.js",
      "dist/processor-failure.d.ts",
      "dist/processor-failure.js",
      "dist/processor-installation.d.ts",
      "dist/processor-installation.js",
      "dist/processor-registry.d.ts",
      "dist/processor-registry.js",
      "dist/profile-connector.d.ts",
      "dist/profile-connector.js",
      "dist/profile-resolution.d.ts",
      "dist/profile-resolution.js",
      "dist/recipe-session.d.ts",
      "dist/recipe-session.js",
      "dist/recording-owner-data.d.ts",
      "dist/recording-owner-data.js",
      "dist/resource.d.ts",
      "dist/resource.js",
      "dist/route-group-runtime.d.ts",
      "dist/route-group-runtime.js",
      "dist/runtime.d.ts",
      "dist/runtime.js",
      "dist/scheduler.d.ts",
      "dist/scheduler.js",
      "dist/settings-store.d.ts",
      "dist/settings-store.js",
      "dist/simulator.d.ts",
      "dist/simulator.js",
      "dist/telemetry-history.d.ts",
      "dist/telemetry-history.js",
      "dist/telemetry-storage.d.ts",
      "dist/telemetry-storage.js",
      "dist/types.d.ts",
      "dist/types.js",
      "dist/watch-companion.d.ts",
      "dist/watch-companion.js",
      "dist/wearable-calibration.d.ts",
      "dist/wearable-calibration.js",
      "dist/workload-handoff.d.ts",
      "dist/workload-handoff.js",
      "dist/workspace-administration.d.ts",
      "dist/workspace-administration.js",
      "LICENSE",
      "package.json",
      "README.md"
    ],
    "metadata": {
      "name": "@101/device-runtime",
      "version": "0.1.0",
      "description": "101 device-runtime SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md"
      ],
      "dependencies": {
        "@101/device-model": "0.1.0"
      }
    }
  },
  {
    "name": "@101/transport-webrtc",
    "version": "0.1.0",
    "files": [
      "dist/index.d.ts",
      "dist/index.js",
      "dist/peer.d.ts",
      "dist/peer.js",
      "dist/ports.d.ts",
      "dist/ports.js",
      "LICENSE",
      "package.json",
      "README.md"
    ],
    "metadata": {
      "name": "@101/transport-webrtc",
      "version": "0.1.0",
      "description": "101 transport-webrtc SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md"
      ]
    }
  },
  {
    "name": "@101/transport-websocket",
    "version": "0.1.0",
    "files": [
      "dist/index.d.ts",
      "dist/index.js",
      "dist/peer.d.ts",
      "dist/peer.js",
      "dist/ports.d.ts",
      "dist/ports.js",
      "LICENSE",
      "package.json",
      "README.md"
    ],
    "metadata": {
      "name": "@101/transport-websocket",
      "version": "0.1.0",
      "description": "101 transport-websocket SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md"
      ]
    }
  },
  {
    "name": "@101/device-web",
    "version": "0.1.0",
    "files": [
      "dist/application-audio.d.ts",
      "dist/application-audio.js",
      "dist/application-media.d.ts",
      "dist/application-media.js",
      "dist/application-video-codec.d.ts",
      "dist/application-video-codec.js",
      "dist/application-view-canvas.d.ts",
      "dist/application-view-canvas.js",
      "dist/authenticated-peer.d.ts",
      "dist/authenticated-peer.js",
      "dist/binding.d.ts",
      "dist/binding.js",
      "dist/browser-ble-switch.d.ts",
      "dist/browser-ble-switch.js",
      "dist/browser-camera.d.ts",
      "dist/browser-camera.js",
      "dist/browser-chooser.d.ts",
      "dist/browser-chooser.js",
      "dist/browser-gamepad.d.ts",
      "dist/browser-gamepad.js",
      "dist/browser-hid-switch.d.ts",
      "dist/browser-hid-switch.js",
      "dist/browser-microphone.d.ts",
      "dist/browser-microphone.js",
      "dist/browser-screen-preview.d.ts",
      "dist/browser-screen-preview.js",
      "dist/browser-serial-switch.d.ts",
      "dist/browser-serial-switch.js",
      "dist/control-input.d.ts",
      "dist/control-input.js",
      "dist/control-surface.d.ts",
      "dist/control-surface.js",
      "dist/gesture-driver.d.ts",
      "dist/gesture-driver.js",
      "dist/gesture-source.d.ts",
      "dist/gesture-source.js",
      "dist/identity-format.d.ts",
      "dist/identity-format.js",
      "dist/identity-types.d.ts",
      "dist/identity-types.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/invitation-connection.d.ts",
      "dist/invitation-connection.js",
      "dist/invitation.d.ts",
      "dist/invitation.js",
      "dist/keyboard-text-driver.d.ts",
      "dist/keyboard-text-driver.js",
      "dist/manual-peer.d.ts",
      "dist/manual-peer.js",
      "dist/native-peer.d.ts",
      "dist/native-peer.js",
      "dist/output-sharing.d.ts",
      "dist/output-sharing.js",
      "dist/pointer-driver.d.ts",
      "dist/pointer-driver.js",
      "dist/pointer-provider.d.ts",
      "dist/pointer-provider.js",
      "dist/touch-contact-driver.d.ts",
      "dist/touch-contact-driver.js",
      "dist/web-identity.d.ts",
      "dist/web-identity.js",
      "dist/wire.d.ts",
      "dist/wire.js",
      "LICENSE",
      "package.json",
      "README.md"
    ],
    "metadata": {
      "name": "@101/device-web",
      "version": "0.1.0",
      "description": "101 device-web SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md"
      ],
      "dependencies": {
        "@101/device-model": "0.1.0",
        "@101/device-runtime": "0.1.0",
        "@101/transport-webrtc": "0.1.0",
        "@101/transport-websocket": "0.1.0"
      }
    }
  },
  {
    "name": "@101/vision",
    "version": "0.1.0",
    "files": [
      "dist/face.d.ts",
      "dist/face.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/overlay.d.ts",
      "dist/overlay.js",
      "dist/people.d.ts",
      "dist/people.js",
      "dist/placement.d.ts",
      "dist/placement.js",
      "dist/processors.d.ts",
      "dist/processors.js",
      "dist/quality.d.ts",
      "dist/quality.js",
      "dist/skeleton.d.ts",
      "dist/skeleton.js",
      "LICENSE",
      "package.json",
      "README.md"
    ],
    "metadata": {
      "name": "@101/vision",
      "version": "0.1.0",
      "description": "101 vision SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md"
      ],
      "dependencies": {
        "@101/device-model": "0.1.0"
      }
    }
  },
  {
    "name": "@101/connect",
    "version": "0.1.0",
    "files": [
      "dist/index.d.ts",
      "dist/index.js",
      "examples/application-media.d.ts",
      "examples/application-media.js",
      "examples/application-media.ts",
      "examples/application-video-codec.d.ts",
      "examples/application-video-codec.js",
      "examples/application-video-codec.ts",
      "examples/application-views.d.ts",
      "examples/application-views.js",
      "examples/application-views.ts",
      "examples/ble-switch-output.d.ts",
      "examples/ble-switch-output.js",
      "examples/ble-switch-output.ts",
      "examples/ble-switch.d.ts",
      "examples/ble-switch.js",
      "examples/ble-switch.ts",
      "examples/camera-controls.d.ts",
      "examples/camera-controls.js",
      "examples/camera-controls.ts",
      "examples/conformance.d.ts",
      "examples/conformance.js",
      "examples/conformance.ts",
      "examples/control-surface.d.ts",
      "examples/control-surface.js",
      "examples/control-surface.ts",
      "examples/durable-artifact-jobs.d.ts",
      "examples/durable-artifact-jobs.js",
      "examples/durable-artifact-jobs.ts",
      "examples/gestures.d.ts",
      "examples/gestures.js",
      "examples/gestures.ts",
      "examples/hid-switch-output.d.ts",
      "examples/hid-switch-output.js",
      "examples/hid-switch-output.ts",
      "examples/hid-switch.d.ts",
      "examples/hid-switch.js",
      "examples/hid-switch.ts",
      "examples/input-details.d.ts",
      "examples/input-details.js",
      "examples/input-details.ts",
      "examples/input-ownership.d.ts",
      "examples/input-ownership.js",
      "examples/input-ownership.ts",
      "examples/invitation-connection.d.ts",
      "examples/invitation-connection.js",
      "examples/invitation-connection.ts",
      "examples/keyboard-text.d.ts",
      "examples/keyboard-text.js",
      "examples/keyboard-text.ts",
      "examples/media-description.d.ts",
      "examples/media-description.js",
      "examples/media-description.ts",
      "examples/media-recording.d.ts",
      "examples/media-recording.js",
      "examples/media-recording.ts",
      "examples/media-synchronization.d.ts",
      "examples/media-synchronization.js",
      "examples/media-synchronization.ts",
      "examples/motion.d.ts",
      "examples/motion.js",
      "examples/motion.ts",
      "examples/output-sharing.d.ts",
      "examples/output-sharing.js",
      "examples/output-sharing.ts",
      "examples/pointer.d.ts",
      "examples/pointer.js",
      "examples/pointer.ts",
      "examples/recipe.d.ts",
      "examples/recipe.js",
      "examples/recipe.ts",
      "examples/recording-owner-data.d.ts",
      "examples/recording-owner-data.js",
      "examples/recording-owner-data.ts",
      "examples/resource-documents.d.ts",
      "examples/resource-documents.js",
      "examples/resource-documents.ts",
      "examples/rich-input.d.ts",
      "examples/rich-input.js",
      "examples/rich-input.ts",
      "examples/run.d.ts",
      "examples/run.js",
      "examples/run.ts",
      "examples/runtime-settlement.d.ts",
      "examples/runtime-settlement.js",
      "examples/runtime-settlement.ts",
      "examples/screen-preview.d.ts",
      "examples/screen-preview.js",
      "examples/screen-preview.ts",
      "examples/secure-websocket.d.ts",
      "examples/secure-websocket.js",
      "examples/secure-websocket.ts",
      "examples/sensor-feedback.d.ts",
      "examples/sensor-feedback.js",
      "examples/sensor-feedback.ts",
      "examples/serial-switch-output.d.ts",
      "examples/serial-switch-output.js",
      "examples/serial-switch-output.ts",
      "examples/serial-switch.d.ts",
      "examples/serial-switch.js",
      "examples/serial-switch.ts",
      "examples/settings-storage.d.ts",
      "examples/settings-storage.js",
      "examples/settings-storage.ts",
      "examples/spatial-joints.d.ts",
      "examples/spatial-joints.js",
      "examples/spatial-joints.ts",
      "examples/telemetry-batch.d.ts",
      "examples/telemetry-batch.js",
      "examples/telemetry-batch.ts",
      "examples/telemetry-history.d.ts",
      "examples/telemetry-history.js",
      "examples/telemetry-history.ts",
      "examples/threshold.d.ts",
      "examples/threshold.js",
      "examples/threshold.ts",
      "examples/timed-pointer.d.ts",
      "examples/timed-pointer.js",
      "examples/timed-pointer.ts",
      "examples/touch-contacts.d.ts",
      "examples/touch-contacts.js",
      "examples/touch-contacts.ts",
      "examples/vision.d.ts",
      "examples/vision.js",
      "examples/vision.ts",
      "LICENSE",
      "package.json",
      "README.md",
      "schema/device-descriptor.json"
    ],
    "metadata": {
      "name": "@101/connect",
      "version": "0.1.0",
      "description": "101 connect SDK",
      "type": "module",
      "license": "MIT",
      "repository": {
        "type": "git",
        "url": "https://github.com/KRISHNAMMurarka/101.git"
      },
      "engines": {
        "node": ">=22.13.0"
      },
      "types": "./dist/index.d.ts",
      "exports": {
        ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js"
        },
        "./schema/device-descriptor.json": "./schema/device-descriptor.json",
        "./examples/pointer": {
          "types": "./examples/pointer.d.ts",
          "import": "./examples/pointer.js"
        },
        "./examples/sensor-feedback": {
          "types": "./examples/sensor-feedback.d.ts",
          "import": "./examples/sensor-feedback.js"
        },
        "./examples/threshold": {
          "types": "./examples/threshold.d.ts",
          "import": "./examples/threshold.js"
        },
        "./examples/telemetry-batch": {
          "types": "./examples/telemetry-batch.d.ts",
          "import": "./examples/telemetry-batch.js"
        },
        "./examples/spatial-joints": {
          "types": "./examples/spatial-joints.d.ts",
          "import": "./examples/spatial-joints.js"
        },
        "./examples/motion": {
          "types": "./examples/motion.d.ts",
          "import": "./examples/motion.js"
        },
        "./examples/vision": {
          "types": "./examples/vision.d.ts",
          "import": "./examples/vision.js"
        },
        "./examples/keyboard-text": {
          "types": "./examples/keyboard-text.d.ts",
          "import": "./examples/keyboard-text.js"
        },
        "./examples/touch-contacts": {
          "types": "./examples/touch-contacts.d.ts",
          "import": "./examples/touch-contacts.js"
        },
        "./examples/gestures": {
          "types": "./examples/gestures.d.ts",
          "import": "./examples/gestures.js"
        },
        "./examples/input-details": {
          "types": "./examples/input-details.d.ts",
          "import": "./examples/input-details.js"
        },
        "./examples/rich-input": {
          "types": "./examples/rich-input.d.ts",
          "import": "./examples/rich-input.js"
        },
        "./examples/resource-documents": {
          "types": "./examples/resource-documents.d.ts",
          "import": "./examples/resource-documents.js"
        },
        "./examples/media-description": {
          "types": "./examples/media-description.d.ts",
          "import": "./examples/media-description.js"
        },
        "./examples/recipe": {
          "types": "./examples/recipe.d.ts",
          "import": "./examples/recipe.js"
        },
        "./examples/settings-storage": {
          "types": "./examples/settings-storage.d.ts",
          "import": "./examples/settings-storage.js"
        },
        "./examples/conformance": {
          "types": "./examples/conformance.d.ts",
          "import": "./examples/conformance.js"
        },
        "./examples/telemetry-history": {
          "types": "./examples/telemetry-history.d.ts",
          "import": "./examples/telemetry-history.js"
        },
        "./examples/control-surface": {
          "types": "./examples/control-surface.d.ts",
          "import": "./examples/control-surface.js"
        },
        "./examples/durable-artifact-jobs": {
          "types": "./examples/durable-artifact-jobs.d.ts",
          "import": "./examples/durable-artifact-jobs.js"
        },
        "./examples/secure-websocket": {
          "types": "./examples/secure-websocket.d.ts",
          "import": "./examples/secure-websocket.js"
        },
        "./examples/application-views": {
          "types": "./examples/application-views.d.ts",
          "import": "./examples/application-views.js"
        },
        "./examples/input-ownership": {
          "types": "./examples/input-ownership.d.ts",
          "import": "./examples/input-ownership.js"
        },
        "./examples/timed-pointer": {
          "types": "./examples/timed-pointer.d.ts",
          "import": "./examples/timed-pointer.js"
        },
        "./examples/application-media": {
          "types": "./examples/application-media.d.ts",
          "import": "./examples/application-media.js"
        },
        "./examples/application-video-codec": {
          "types": "./examples/application-video-codec.d.ts",
          "import": "./examples/application-video-codec.js"
        },
        "./examples/media-synchronization": {
          "types": "./examples/media-synchronization.d.ts",
          "import": "./examples/media-synchronization.js"
        },
        "./examples/output-sharing": {
          "types": "./examples/output-sharing.d.ts",
          "import": "./examples/output-sharing.js"
        },
        "./examples/invitation-connection": {
          "types": "./examples/invitation-connection.d.ts",
          "import": "./examples/invitation-connection.js"
        },
        "./examples/run": {
          "types": "./examples/run.d.ts",
          "import": "./examples/run.js"
        },
        "./examples/media-recording": {
          "types": "./examples/media-recording.d.ts",
          "import": "./examples/media-recording.js"
        },
        "./examples/recording-owner-data": {
          "types": "./examples/recording-owner-data.d.ts",
          "import": "./examples/recording-owner-data.js"
        },
        "./examples/hid-switch": {
          "types": "./examples/hid-switch.d.ts",
          "import": "./examples/hid-switch.js"
        },
        "./examples/serial-switch": {
          "types": "./examples/serial-switch.d.ts",
          "import": "./examples/serial-switch.js"
        },
        "./examples/screen-preview": {
          "types": "./examples/screen-preview.d.ts",
          "import": "./examples/screen-preview.js"
        },
        "./examples/ble-switch": {
          "types": "./examples/ble-switch.d.ts",
          "import": "./examples/ble-switch.js"
        },
        "./examples/camera-controls": {
          "types": "./examples/camera-controls.d.ts",
          "import": "./examples/camera-controls.js"
        },
        "./examples/ble-switch-output": {
          "types": "./examples/ble-switch-output.d.ts",
          "import": "./examples/ble-switch-output.js"
        },
        "./examples/hid-switch-output": {
          "types": "./examples/hid-switch-output.d.ts",
          "import": "./examples/hid-switch-output.js"
        },
        "./examples/serial-switch-output": {
          "types": "./examples/serial-switch-output.d.ts",
          "import": "./examples/serial-switch-output.js"
        },
        "./examples/runtime-settlement": {
          "types": "./examples/runtime-settlement.d.ts",
          "import": "./examples/runtime-settlement.js"
        }
      },
      "files": [
        "dist",
        "LICENSE",
        "README.md",
        "schema",
        "examples"
      ],
      "dependencies": {
        "@101/device-model": "0.1.0",
        "@101/device-runtime": "0.1.0",
        "@101/device-web": "0.1.0",
        "@101/transport-webrtc": "0.1.0",
        "@101/vision": "0.1.0",
        "@101/transport-websocket": "0.1.0"
      }
    }
  }
];

// Emitter only: no auditor or parsing oracle. The real CLI consumes every archive.
const emitFixture = String.raw`
import gzip, hashlib, io, json, pathlib, sys, tarfile
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; shapes=json.loads(sys.argv[3])
sha=lambda b:hashlib.sha256(b).hexdigest()
encode=lambda v:(json.dumps(v,indent=2)+'\n').encode()
records=[]; (root/'tarballs').mkdir(); source_tree='1'*40
for package in shapes:
 name=package['name']; target=name=='@101/device-model'; files={}
 for path in package['files']:
  files[path]=b'export {};\n' if path.endswith(('.js','.ts')) else b'public fixture\n'
 files['package.json']=encode(package['metadata']); files['LICENSE']=b'MIT License\nCopyright 101\n'
 files['README.md']=b'# Public SDK fixture\n'
 if name=='@101/connect' and mode in ['telemetry-owner','arbitrary-mjs']:
  example='telemetry-owner' if mode=='telemetry-owner' else 'unreviewed'
  metadata=dict(package['metadata']); metadata['exports']=dict(metadata['exports'])
  metadata['exports']['./examples/'+example]='./examples/'+example+'.mjs'
  files['package.json']=encode(metadata); files['examples/'+example+'.mjs']=b'export {};\n'
 if 'schema/device-descriptor.json' in files: files['schema/device-descriptor.json']=encode({'$schema':'https://json-schema.org/draft/2020-12/schema','type':'object'})
 if target:
  if mode=='payload-marker': files['dist/index.js']+=b'// -----BEGIN PRIVATE KEY-----K12_SDK_PRIVATE_FIXTURE\n'
  if mode=='split-marker': files['dist/index.js']=b'A'*65530+b'-----BEGIN PRIVATE KEY-----K12_SDK_PRIVATE_FIXTURE'
  if mode=='workspace-marker': files['dist/index.js']+=str(root).encode()
  if mode=='temporary-marker': files['dist/index.js']+=b'/tmp/101-sdk-source-K12_SDK_PRIVATE_FIXTURE/file.ts'
  if mode=='file-bound': files['dist/index.js']=b'A'*(2*1024*1024+1)
  if mode=='missing-license': del files['LICENSE']
 directory=root/'packages'/name[5:]; directory.mkdir(parents=True)
 for path,data in files.items():
  dest=directory/path; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data)
 member_files=dict(files)
 if target and mode=='undeclared-file': member_files['dist/unlisted.js']=b'export {};'
 if target and mode=='private-file': member_files['.env.production']=b'K12_SDK_PRIVATE_FIXTURE'
 raw=io.BytesIO()
 with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as archive:
  for path,data in sorted(member_files.items()):
   info=tarfile.TarInfo('package/'+path); info.size=len(data); info.mode=0o644; info.mtime=499162500
   if target and path=='LICENSE':
    if mode=='metadata-marker': info.pax_headers={'comment':'-----BEGIN PRIVATE KEY-----K12_SDK_PRIVATE_FIXTURE'}
    if mode=='metadata-workspace': info.pax_headers={'comment':str(root)}
    if mode=='metadata-split-marker': info.pax_headers={'comment':'A'*65530+'-----BEGIN PRIVATE KEY-----K12_SDK_PRIVATE_FIXTURE'}
    if mode=='tar-link': info.type=tarfile.SYMTYPE; info.linkname='../K12_SDK_PRIVATE_FIXTURE'; info.size=0
    if mode=='tar-hardlink': info.type=tarfile.LNKTYPE; info.linkname='package/dist/index.js'; info.size=0
    if mode=='tar-sparse': info.type=tarfile.GNUTYPE_SPARSE
   archive.addfile(info,io.BytesIO(data) if info.size else None)
  if target and mode in ['tar-duplicate','tar-traversal']:
   info=tarfile.TarInfo('package/LICENSE' if mode=='tar-duplicate' else 'package/../K12_SDK_PRIVATE_FIXTURE'); info.size=6; archive.addfile(info,io.BytesIO(b'public'))
 decoded=raw.getvalue()
 if target and mode=='decoded-bound': decoded=b'\0'*(16*1024*1024+1)
 if target and mode=='trailing-marker': decoded+=b'-----BEGIN PRIVATE KEY-----K12_SDK_PRIVATE_FIXTURE'
 compressed=gzip.compress(decoded,mtime=0)
 if target and mode=='compressed-bound': compressed=b'X'*(2*1024*1024+1)
 if target and mode=='gzip-truncated': compressed=compressed[:-8]
 if target and mode=='gzip-corrupt': compressed=compressed[:-8]+b'XXXXXXXX'
 filename=name[1:].replace('/','-')+'-'+package['version']+'.tgz'; archive_path=root/'tarballs'/filename; archive_path.write_bytes(compressed)
 inventory=[{'path':p,'size':len(b),'sha256':sha(b)} for p,b in sorted(files.items())]
 if target and mode=='payload-digest': inventory[0]['sha256']='0'*64
 if target and mode=='payload-size': inventory[0]['size']+=1
 if target and mode=='inventory-duplicate': inventory.append(dict(inventory[0]))
 if target and mode=='files-bound': inventory*=4
 records.append({'name':name,'version':package['version'],'license':'MIT','directory':str(directory),'tarball':str(archive_path),'sha256':sha(compressed),'bytes':len(compressed),'files':inventory})
manifest={'schemaVersion':1,'source':{'revision':None,'tree':source_tree,'sha256':{'LICENSE':sha(b'MIT License\nCopyright 101\n')}},
 'environment':{'node':'24.14.0','npm':'11.9.0','typescript':'5.9.3'},'builderSha256':'2'*64,'outputDir':str(root),'packages':records}
if mode=='schema-future': manifest['schemaVersion']=2
if mode=='source-substitution': manifest['source']['tree']='3'*40
if mode=='outer-tar-digest': manifest['packages'][0]['sha256']='0'*64
if mode=='package-substitution': manifest['packages'][0]['name']='@101/unreviewed'
encoded=encode(manifest)
if mode=='manifest-malformed': encoded=b'{'
if mode=='manifest-bound': encoded=b' '*1048577
(root/'manifest.json').write_bytes(encoded)
print(json.dumps({'fixture':'ready','packages':7,'compiledRuntime':False}))
`;

function fixture(mode = 'ordinary') {
  const root = mkdtempSync(join(tmpdir(), '101-sdk-content-test-'));
  try {
    const child = spawnSync(python, ['-I', '-S', '-B', '-c', emitFixture, root, mode, JSON.stringify(packageShapes)], {
      encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, 'Emitter must settle before content assertion'); assert.equal(child.signal, null); assert.equal(child.error, undefined);
    assert.deepEqual(JSON.parse(child.stdout), { fixture: 'ready', packages: 7, compiledRuntime: false });
    const manifest = join(root, 'manifest.json'), output = join(root, 'content-audit.json'), manifestSha = sha256(readFileSync(manifest));
    const toolSha = existsSync(audit) ? sha256(readFileSync(audit)) : '0'.repeat(64);
    return { root, manifest, output, manifestSha, toolSha,
      run(overrides: { manifestSha?: string; tree?: string; toolSha?: string; roots?: string[] } = {}) {
        const args = ['-I', '-S', '-B', audit, '--manifest', manifest, '--manifest-sha256', overrides.manifestSha ?? manifestSha,
          '--artifact-root', root, '--source-tree', overrides.tree ?? sourceTree, '--audit-tool-sha256', overrides.toolSha ?? toolSha, '--output', output];
        for (const value of overrides.roots ?? [root]) args.push('--workspace-root', value);
        return spawnSync(python, args, { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      }, close() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function rejected(mode: string, reason: string, overrides: Parameters<ReturnType<typeof fixture>['run']>[0] = {}) {
  const f = fixture(mode);
  try {
    const result = f.run(overrides); assert.equal(result.status, 1, 'Refusal must be a real content command verdict');
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout); assert.equal(report.schemaVersion, 1); assert.equal(report.auditProfile, 'sdk-content-audit/1');
    assert.equal(report.result, 'fail'); assert.equal(report.reason, reason); assert.equal(report.releaseAccepted, false);
    const all = result.stdout + result.stderr + (existsSync(f.output) ? readFileSync(f.output, 'utf8') : '');
    for (const value of [privateFixture, f.root, marker]) assert.ok(!all.includes(value), 'Report must exclude matched and caller values');
    assert.equal(sha256(readFileSync(f.manifest)), f.manifestSha, 'Immutable manifest preserved');
  } finally { f.close(); }
}

test('SDK content gate rejects a harmless PEM marker in immutable producer output', () => {
  const actual = process.env.ONE01_K12_SDK_OLD_PRODUCER_RECEIPT;
  if (actual) {
    const expected = process.env.ONE01_K12_SDK_OLD_PRODUCER_RECEIPT_SHA256; assert.ok(expected);
    const bytes = readFileSync(actual); assert.equal(sha256(bytes), expected);
    const evidence = JSON.parse(bytes.toString());
    assert.equal(evidence.schemaVersion, 1); assert.equal(evidence.qaProfile, 'sdk-marker-producer-old/1');
    assert.equal(evidence.producerIssued, true); assert.equal(evidence.producerSettled, true); assert.equal(evidence.rawChildrenAtReturn, 0);
    assert.equal(evidence.builderExitCode, 0); assert.equal(evidence.tarballs, 7); assert.equal(evidence.payloadInventoriesBound, true);
    assert.equal(evidence.markerObservedInAllowedPayload, true); assert.equal(evidence.markerClass, 'private-key');
    assert.equal(evidence.markerPackage, '@101/device-model'); assert.equal(evidence.markerRelativePath, 'dist/index.js');
    assert.match(evidence.sourceTree, /^[0-9a-f]{40}$/); assert.match(evidence.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(sha256(readFileSync(evidence.manifestPath)), evidence.manifestSha256);
    const payload = readFileSync(evidence.markerPayloadPath); assert.equal(sha256(payload), evidence.markerPayloadSha256);
    assert.ok(payload.includes(Buffer.from(marker)), 'Actual allowed compiled payload must carry harmless marker');
    assert.equal(evidence.builderRejectedPrivateContent, true, 'Existing real producer accepted forbidden content after valid7package prefix');
    return;
  }
  rejected('payload-marker', 'private-content');
});

test('missing seven-package SDK decoded contents command', () => {
  const f = fixture();
  try {
    const result = f.run(); assert.equal(result.status, 0, 'Missing audit cannot qualify7packed contents'); assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const report = JSON.parse(readFileSync(f.output, 'utf8'));
    assert.equal(report.auditProfile, 'sdk-content-audit/1'); assert.equal(report.result, 'pass'); assert.equal(report.reason, 'ok');
    assert.equal(report.sdkManifestSha256, f.manifestSha); assert.equal(report.sourceTree, sourceTree); assert.equal(report.toolSha256, f.toolSha);
    assert.equal(report.artifacts.length, 7); assert.equal(report.files, 394); assert.equal(report.releaseAccepted, false);
  } finally { f.close(); }
});

const refusals = [
  ['split-marker', 'private-content', 'marker spanning payload read chunks'],
  ['workspace-marker', 'private-content', 'explicit trusted workspace bytes in allowed JS'],
  ['temporary-marker', 'private-content', 'temporary SDK source stem in allowed JS'],
  ['metadata-marker', 'private-content', 'private marker hidden in PAX metadata'],
  ['metadata-workspace', 'private-content', 'workspace bytes hidden in PAX metadata'],
  ['metadata-split-marker', 'private-content', 'marker split across raw metadata read chunks'],
  ['trailing-marker', 'private-content', 'marker after parser archive EOF'],
  ['private-file', 'private-file', 'private environment member'],
  ['undeclared-file', 'undeclared-file', 'additional unlisted ordinary member'],
  ['tar-duplicate', 'unsafe-archive', 'duplicate archive path'],
  ['tar-traversal', 'unsafe-archive', 'parent traversal archive path'],
  ['tar-link', 'unsafe-archive', 'symbolic link archive member'],
  ['tar-hardlink', 'unsafe-archive', 'hard link archive member'],
  ['tar-sparse', 'unsafe-archive', 'sparse archive member'],
  ['gzip-truncated', 'archive-corrupt', 'truncated compressed trailer'],
  ['gzip-corrupt', 'archive-corrupt', 'invalid compressed checksum'],
  ['payload-digest', 'artifact-integrity', 'decoded member digest substitution'],
  ['payload-size', 'artifact-integrity', 'decoded member byte length substitution'],
  ['outer-tar-digest', 'artifact-integrity', 'outer tar digest substitution'],
  ['source-substitution', 'source-identity', 'repinned manifest carries different source tree'],
  ['package-substitution', 'unsupported-schema', 'undeclared package identity'],
  ['inventory-duplicate', 'unsupported-schema', 'duplicate inventory record'],
  ['missing-license', 'inventory-mismatch', 'requiredlicense removed from matching inventory'],
  ['schema-future', 'unsupported-schema', 'future manifest version'],
  ['manifest-malformed', 'unsupported-schema', 'malformed manifest bytes'],
  ['manifest-bound', 'limit-exceeded', 'oversized manifest'],
  ['files-bound', 'limit-exceeded', 'oversized inventory list'],
  ['file-bound', 'limit-exceeded', 'oversized declared payload'],
  ['decoded-bound', 'limit-exceeded', 'bounded gzip expansion'],
  ['compressed-bound', 'limit-exceeded', 'oversized compressed input'],
  ['arbitrary-mjs', 'unsupported-schema', 'undeclared MJS example despite matching inventory'],
] as const;
for (const [mode, reason, title] of refusals) test(`SDK contents refuses ${title}`, () => rejected(mode, reason));

test('SDK contents refuses substituted outer manifest digest', () => rejected('ordinary', 'artifact-integrity', { manifestSha: '0'.repeat(64) }));
test('SDK contents refuses substituted auditor helper digest', () => rejected('ordinary', 'tool-identity', { toolSha: '0'.repeat(64) }));
test('SDK contents accepts only the explicitly declared optional telemetry MJS example', () => {
  const f = fixture('telemetry-owner');
  try {
    const result = f.run(); assert.equal(result.status, 0); assert.equal(result.signal, null); assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout); assert.equal(report.result, 'pass'); assert.equal(report.files, 395);
    assert.equal(report.artifacts.find((item: { name: string }) => item.name === '@101/connect').files, 130);
  } finally { f.close(); }
});
test('SDK contents preserves an existing output receipt', () => {
  const f = fixture();
  try { writeFileSync(f.output, privateFixture); const result = f.run(); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'output-exists'); assert.equal(readFileSync(f.output, 'utf8'), privateFixture); }
  finally { f.close(); }
});
test('SDK contents refuses an interior tarball symlink without touching its target', () => {
  const f = fixture();
  try {
    const manifest = JSON.parse(readFileSync(f.manifest, 'utf8')), tarball = manifest.packages[0].tarball;
    const saved = readFileSync(tarball), target = join(f.root, 'saved.tgz'); writeFileSync(target, saved); rmSync(tarball); symlinkSync(target, tarball);
    const result = f.run(); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'unsafe-file'); assert.equal(sha256(readFileSync(target)), sha256(saved));
  } finally { f.close(); }
});
test('SDK contents rejects more than4explicit workspace roots', () => {
  const f = fixture();
  try {
    const roots = Array.from({ length: 5 }, (_, index) => join(f.root, `workspace-${index}`)); for (const root of roots) mkdirSync(root);
    const result = f.run({ roots }); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).reason, 'invalid-arguments');
  } finally { f.close(); }
});
test('SDK contents QA binds actual child verdict and keeps sentinel output untouched', () => {
  const f = fixture(), output = join(f.root, 'qa-owned');
  try {
    const result = spawnSync(process.execPath, [qa, '--manifest', f.manifest, '--manifest-sha256', f.manifestSha,
      '--artifact-root', f.root, '--source-tree', sourceTree, '--audit-tool-sha256', f.toolSha,
      '--workspace-root', f.root, '--python', python, '--output-root', output], { encoding: 'utf8', timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0); const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.outerManifestBound, true); assert.equal(receipt.childIssued, true); assert.equal(receipt.childSettled, true); assert.equal(receipt.rawChildrenAtReturn, 0);
    assert.equal(receipt.artifacts.length, 7); assert.equal(receipt.auditResult, 'pass'); assert.equal(receipt.auditReason, 'ok'); assert.equal(receipt.productPayloadExecution, false);
    const before = readFileSync(join(output, 'qa-receipt.json'));
    const again = spawnSync(process.execPath, [qa, '--manifest', f.manifest, '--manifest-sha256', f.manifestSha,
      '--artifact-root', f.root, '--source-tree', sourceTree, '--audit-tool-sha256', f.toolSha,
      '--workspace-root', f.root, '--python', python, '--output-root', output], { encoding: 'utf8', timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(again.status, 1); assert.deepEqual(readFileSync(join(output, 'qa-receipt.json')), before);
  } finally { f.close(); }
});
