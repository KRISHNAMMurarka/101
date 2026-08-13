# Application targets

The web launcher and installable 101 Link PWA live in the root `app/` directory because that is the browser runtime's application boundary. The PWA already selects same-browser or signaled WebRTC transport and renders host-defined controller JSON.

Native application targets build on that public protocol rather than forking it:

- `controller-native` — Expo / React Native iOS and Android 101 Link
- `desktop-hub` — Tauri local session coordinator and packaged launcher
- `watch-ios` — lightweight watchOS companion relayed through iPhone
- `watch-wear` — lightweight Wear OS companion with explicit transport reporting

Do not fork gameplay into these targets. They provide normalized input and controller UI through 101 Protocol.
