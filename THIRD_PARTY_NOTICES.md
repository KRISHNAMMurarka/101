# Third-party notices

101-authored source is MIT licensed. The following direct runtime foundations retain their own copyright and license terms. Their inclusion does not imply that their authors endorse 101.

| Dependency | Committed version | License | Use |
| --- | ---: | --- | --- |
| Phaser | 3.90.0 | MIT | 2D rendering facade |
| Three.js | 0.179.1 | MIT | 3D rendering facade |
| Rapier JavaScript 2D compatibility build | 0.19.3 | Apache-2.0 | Physics facade |
| Howler.js | 2.2.4 | MIT | Audio facade |
| React / React DOM | 19.2.8 | MIT | Launcher and controller UI |
| React Native | 0.86.2 | MIT | Native iOS/Android 101 Link UI runtime |
| Expo | 57.0.12 | MIT | Native app build/runtime and device-module foundation |
| React Native WebRTC | 124.0.8 | MIT | Native peer-to-peer controller DataChannels |
| Expo Camera / Sensors / Haptics / Secure Store | 57.0.x | MIT | QR scan, local motion, haptic feedback and device identity storage |
| pako | 3.0.1 | MIT | Native decoding of compact manual pairing descriptions |
| base64-js | 1.5.1 | MIT | Native pairing-ticket binary encoding |
| QRCode | 1.5.4 | MIT | Local pairing-ticket QR generation |
| Tauri | 2.11.5 | MIT OR Apache-2.0 | Desktop 101 Hub application shell |
| Axum | 0.8.9 | MIT | Native local Hub HTTP signaling service |
| mdns-sd | 0.21.0 | MIT OR Apache-2.0 | Strict-local DNS-SD service advertisement |
| Vite | 8.0.13 | MIT | Build tooling |
| vinext | 1.0.0-beta.2 | MIT | Browser application runtime/build integration |
| Cloudflare Vite plugin | 1.37.1 | MIT | Hosted preview adapter |
| MediaPipe Tasks Vision | 1.0.1 | Apache-2.0 | Bundled browser pose/hand inference and WebAssembly runtime |
| BlazePose GHUM Pose Landmarker Lite model | float16 bundle, revision 1 | Apache-2.0 | Bundled single-person 33-landmark pose model |
| MediaPipe Hand Landmarker model | float16 bundle, revision 1 | Apache-2.0 | Bundled 21-landmark hand model |

The generated `THIRD_PARTY_LICENSES.json` and `THIRD_PARTY_RUST_LICENSES.json` files record licenses declared by every installed JavaScript and Rust dependency at the exact locked version. Redistributions must include the full license texts required by those packages; this summary is not a substitute for their licenses.

The committed MediaPipe models and WebAssembly files remain under their Apache-2.0 terms; a full copy is included at `third_party/APACHE-2.0.txt`. Their exact integrity hashes and limitations are recorded in `docs/vision.md`. No third-party game artwork, characters, music, sound effects, trademarks, or example assets are included.
