# Application targets

The Phase 1 web launcher and controller route live in the root `app/` directory because that is the hosting runtime's application boundary.

Planned application targets enter only when their supporting engine phase is ready:

- `controller-native` — Expo / React Native iOS and Android 101 Link
- `desktop-hub` — Tauri local session coordinator and packaged launcher
- `watch-ios` — lightweight watchOS companion relayed through iPhone
- `watch-wear` — lightweight Wear OS companion with explicit transport reporting

Do not fork gameplay into these targets. They provide normalized input and controller UI through 101 Protocol.
