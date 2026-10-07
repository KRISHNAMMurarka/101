import { parseProcessorExtensionRelease, verifyProcessorExtensionRelease } from '@101/connect';
import type { ProcessorExtensionRelease, TrustedProcessorRegistration, ProcessorConformanceFixture, SignalValue } from '@101/connect';
import { createTemperatureBand as inclusiveFactory } from '../../../examples/external-processor/processor.mjs';
import { createTemperatureBand as strictFactory } from '../../../examples/extension-installation/temperature-band-v2.mjs';

/** Fixed public-only local provision. No incoming data selects a module or a factory. */
const provision = {
  "publisherKey": {
    "key_ops": [
      "verify"
    ],
    "ext": true,
    "kty": "EC",
    "x": "rIh_FSmD7hCkUkCuFdwjwqX3D0odMDGhb89Oqtj4bSM",
    "y": "8-joAhDaRzGlPROuikA49cEg2pAgatX13ckmnJCGMGQ",
    "crv": "P-256"
  },
  "releases": [
    {
      "schemaVersion": 1,
      "profile": "reviewed-processor-extension/1",
      "publisherId": "example:local-publisher",
      "packageId": "example:temperature-band",
      "version": "1.0.0",
      "sequence": 1,
      "abi": "101:processor/1",
      "runtimeVersion": "0.1.0",
      "manifest": {
        "schemaVersion": 1,
        "id": "example:temperature-band",
        "version": "1.0.0",
        "codeSha256": "e1eed4f1a57e13304f79fe1403af92d127d113858799f78c143891d18e67c740",
        "inputs": [
          {
            "id": "temperature",
            "value": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            }
          }
        ],
        "outputs": [
          {
            "id": "switch",
            "value": {
              "type": "boolean"
            }
          }
        ],
        "configuration": {
          "type": "record",
          "fields": {
            "onAt": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            },
            "offAt": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            }
          }
        },
        "state": {
          "mode": "resettable",
          "resetOn": [
            "input-loss",
            "stop",
            "reconfigure"
          ]
        },
        "assets": [],
        "license": "MIT",
        "budgets": {
          "maxComputeMs": 5,
          "maxMemoryBytes": 65536,
          "privacy": "local-only"
        }
      },
      "manifestSha256": "b3981b27b1694e6242b21ab3c74bd92d5427d12783ff19b7d3ce5669529699e9",
      "source": {
        "id": "example:reviewed-source",
        "kind": "blob",
        "mediaType": "application/octet-stream",
        "byteLength": 630,
        "sha256": "e1eed4f1a57e13304f79fe1403af92d127d113858799f78c143891d18e67c740"
      },
      "privileges": [
        "compute-local"
      ],
      "dependencies": [],
      "signature": "2d9102d0280432d8ffd5b6e6e1aec652be250ca2cacc9e471fe40d56bc5242df1082b1b6e3c1d52b5f7a1168e3995d5cdd543aff17ebe982ae943abe2d809d4f"
    },
    {
      "schemaVersion": 1,
      "profile": "reviewed-processor-extension/1",
      "publisherId": "example:local-publisher",
      "packageId": "example:temperature-band",
      "version": "2.0.0",
      "sequence": 2,
      "abi": "101:processor/1",
      "runtimeVersion": "0.1.0",
      "manifest": {
        "schemaVersion": 1,
        "id": "example:temperature-band",
        "version": "2.0.0",
        "codeSha256": "9bee907c87a6b5621a5d145bcca277838e7d8cfc8082fc156c05ca18826beca8",
        "inputs": [
          {
            "id": "temperature",
            "value": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            }
          }
        ],
        "outputs": [
          {
            "id": "switch",
            "value": {
              "type": "boolean"
            }
          }
        ],
        "configuration": {
          "type": "record",
          "fields": {
            "onAt": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            },
            "offAt": {
              "type": "scalar",
              "unit": "Cel",
              "min": -40,
              "max": 125
            }
          }
        },
        "state": {
          "mode": "resettable",
          "resetOn": [
            "input-loss",
            "stop",
            "reconfigure"
          ]
        },
        "assets": [],
        "license": "MIT",
        "budgets": {
          "maxComputeMs": 5,
          "maxMemoryBytes": 65536,
          "privacy": "local-only"
        }
      },
      "manifestSha256": "62254faab61fad98b8f112e83f28093158b9904af5269955d61d2dc3c2061cba",
      "source": {
        "id": "example:reviewed-source",
        "kind": "blob",
        "mediaType": "application/octet-stream",
        "byteLength": 580,
        "sha256": "9bee907c87a6b5621a5d145bcca277838e7d8cfc8082fc156c05ca18826beca8"
      },
      "privileges": [
        "compute-local"
      ],
      "dependencies": [],
      "signature": "6af149ab85b3e8d4c0cd8b61e461b53ea6031217b987b9f96ad80ebab3846c1aef14fa332bf095dda972f4e72a4099a97ffd40c897c00f47fb1fe4508a5d1eb0"
    }
  ]
};
// Exact reviewed source artifacts are integrity data, not evaluated code.
const sources = ["/** Independent pure processor: the host owns all resources and lifecycle. */\nexport function createTemperatureBand(configuration) {\n  const { onAt, offAt } = configuration;\n  if (!Number.isFinite(onAt) || !Number.isFinite(offAt) || onAt <= offAt)\n    throw new RangeError('Temperature band requires ordered finite limits');\n  let state;\n  return {\n    process(inputs) {\n      const value = inputs.temperature;\n      const next = value >= onAt ? true : value <= offAt ? false : state;\n      if (next === state) return undefined;\n      state = next;\n      return { switch: next };\n    },\n    reset() { state = undefined; },\n  };\n}\n","/** Reviewed v2 uses strict boundaries, making update and rollback observable at exactly 30 Cel. */\nexport function createTemperatureBand({ onAt, offAt }) {\n  if (!Number.isFinite(onAt) || !Number.isFinite(offAt) || offAt >= onAt) throw new TypeError('temperature-thresholds');\n  let state;\n  return {\n    process({ temperature }) {\n      const next = temperature > onAt ? true : temperature <= offAt ? false : state;\n      if (next === undefined || next === state) return undefined;\n      state = next; return { switch: state };\n    },\n    reset() { state = undefined; },\n  };\n}\n"] as const;
export const TRUSTED_PROCESSOR_SOURCE_PINS = Object.freeze([
  Object.freeze({ path: 'examples/external-processor/processor.mjs', sha256: provision.releases[0]!.source.sha256 }),
  Object.freeze({ path: 'examples/extension-installation/temperature-band-v2.mjs', sha256: provision.releases[1]!.source.sha256 }),
]);
export interface TrustedProcessorVersion {
  readonly release: Readonly<ProcessorExtensionRelease>;
  readonly trusted: TrustedProcessorRegistration;
  readonly fixture: ProcessorConformanceFixture;
}
export interface TrustedProcessorBundle {
  readonly key: CryptoKey;
  readonly publisherId: 'example:local-publisher';
  readonly minimumSequence: 1;
  readonly versions: readonly TrustedProcessorVersion[];
}
/** Called only by an explicit Manage action. Imports only the fixed public verification key. */
export async function loadTrustedProcessors(): Promise<TrustedProcessorBundle> {
  const key = await crypto.subtle.importKey('jwk', provision.publisherKey,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const factories = [inclusiveFactory, strictFactory];
  const versions: TrustedProcessorVersion[] = [];
  for (let index = 0; index < 2; index++) {
    const release = parseProcessorExtensionRelease(provision.releases[index]);
    const source = new TextEncoder().encode(sources[index]!);
    if (!await verifyProcessorExtensionRelease(release, source, key)) throw new TypeError('reviewed-provision');
    const factory = factories[index]!;
    versions.push(Object.freeze({ release, trusted: Object.freeze({ manifest: release.manifest, source,
      factory(configuration: SignalValue) {
        // The actual registry parses the declared record schema before calling this binding.
        const implementation = factory(configuration as { onAt: number; offAt: number });
        return Object.freeze({
          process(inputs: Readonly<Record<string, SignalValue>>) { return implementation.process({ temperature: inputs.temperature }); },
          reset() { implementation.reset(); },
        });
      } }), fixture: Object.freeze({
        configuration: { onAt: 30, offAt: 28 }, invalidConfiguration: { onAt: 'bad', offAt: 28 },
        invalidInputs: { temperature: 'bad' }, cases: index === 0
          ? [{ inputs: { temperature: 30 }, outputs: { switch: true } }, { inputs: { temperature: 29 } }, { inputs: { temperature: 28 }, outputs: { switch: false } }]
          : [{ inputs: { temperature: 30 } }, { inputs: { temperature: 31 }, outputs: { switch: true } }, { inputs: { temperature: 28 }, outputs: { switch: false } }],
      }) }));
  }
  return Object.freeze({ key, publisherId: 'example:local-publisher', minimumSequence: 1, versions: Object.freeze(versions) });
}
