# Privacy and security

## Defaults

- No account is required.
- No analytics or telemetry is enabled.
- No recording is enabled.
- No camera, microphone, or motion permission is requested before a selected controller role needs it.
- Raw camera frames remain local; normal network payloads contain only landmarks, gestures, or normalized actions.
- Face landmarks may control a game but are never used to identify a person.
- Health data is outside normal game operation.

## Permission copy

Permission screens should name the capability and the immediate purpose:

- **Camera:** Control this game using your hands or body. Video is processed on this device and is not recorded.
- **Motion sensors:** Use this phone as a steering wheel or motion controller.
- **Microphone:** Detect sound for this optional mode. Audio is processed locally and is not recorded.

Denial must return the user to a conventional fallback mapping.

## Local network security

Pairing codes are discovery aids, not long-term authentication secrets. WebRTC sessions should use ephemeral keys, display both devices during confirmation, expire offers, and reject protocol-version mismatches. The Hub must bind only to intended interfaces and clearly show which network transport is active.

Manual offline pairing data can be transferred by QR or code, but must be size-limited and strictly validated before use.

## Untrusted game packages

Downloaded games will eventually require signed manifests, declared capabilities, version compatibility checks, content security boundaries, and user confirmation for new permissions. A game manifest cannot grant itself sensor or filesystem access.

## Reporting

See [SECURITY.md](../SECURITY.md) for responsible vulnerability reporting. Do not include personal data, access tokens, private recordings, or production pairing payloads in a report.
