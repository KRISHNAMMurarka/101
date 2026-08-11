# Third-party notices

101-authored source is MIT licensed. The following direct runtime foundations retain their own copyright and license terms. Their inclusion does not imply that their authors endorse 101.

| Dependency | Committed version | License | Use |
| --- | ---: | --- | --- |
| Phaser | 3.90.0 | MIT | 2D rendering facade |
| Three.js | 0.179.1 | MIT | 3D rendering facade |
| Rapier JavaScript 2D compatibility build | 0.19.3 | Apache-2.0 | Physics facade |
| Howler.js | 2.2.4 | MIT | Audio facade |
| React / React DOM | 19.2.6 | MIT | Launcher and controller UI |
| Vite | 8.0.13 | MIT | Build tooling |
| vinext | 1.0.0-beta.2 | MIT | Browser application runtime/build integration |
| Cloudflare Vite plugin | 1.37.1 | MIT | Hosted preview adapter |
| MediaPipe Tasks Vision | 1.0.1 | Apache-2.0 | Bundled browser pose inference and WebAssembly runtime |
| BlazePose GHUM Pose Landmarker Lite model | float16 bundle, revision 1 | Apache-2.0 | Bundled single-person 33-landmark pose model |

The generated `THIRD_PARTY_LICENSES.json` file records licenses declared by every installed production and development dependency at the exact locked version. Redistributions must include the full license texts required by those packages; this summary is not a substitute for their licenses.

The committed MediaPipe model and WebAssembly files remain under their Apache-2.0 terms; a full copy is included at `third_party/APACHE-2.0.txt`. Their exact integrity hashes and limitations are recorded in `docs/vision.md`. No third-party game artwork, characters, music, sound effects, trademarks, or example assets are included.
