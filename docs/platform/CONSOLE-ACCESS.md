# Console receiver access

Decision checked 9 October 2026; local receiver implementation added 18 October. Native Nintendo Switch/Switch 2, PlayStation 5 and Xbox GDK receivers are unavailable in the current local release. Xbox UWP/WebView2 now has an authored local receiver, UWP host source and build path; Windows compilation and Xbox target qualification remain unavailable. **N11 stays open.** None of these outcomes grants console system control or control of another game.

The [support catalog](support-catalog.json) records each route separately. `unsupported` means that the named route is unavailable in this release; it does not mean that the platform can never be supported. Every console row retains `accepted: false` and no qualified target evidence. The [research receipt](receipts/2026-10-09-console-access.json) binds the original local decision and its limits. The new [local receiver source and instructions](../../apps/console-receiver/README.md) are a separately tested application candidate.

## Nintendo Switch and Switch 2

Nintendo's public process requires registration and acceptance of portal agreements. Switch development access has a separate application. Registration alone therefore does not establish permission to use Switch APIs. [Nintendo development process](https://developer.nintendo.com/the-process)

The public Switch 2 notice checked on the decision date says that requests for development environment access are not currently being accepted. This describes new requests through that public route; it does not establish the status of an existing approved developer. [Nintendo Switch 2 notice](https://developer.nintendo.com/home/developing-for-switch2)

The current release admits no Nintendo console SDK, approved receiver artifact or console API authority. The `console-nintendo-native` row offers no resources. Native controller injection, another title's inputs, protected capture, account access and system navigation remain unavailable. A later approved application must have its own exact target row and qualification; an ordinary browser receipt cannot supply Nintendo native evidence.

## PlayStation 5

Sony's published guidance from 26 July 2022 connects development hardware requests to registered partners and accepted game concepts, subject to its terms. It describes a partner route rather than open native APIs. The partner portal is an entry point; this decision does not infer private SDK terms from its public landing page. [Sony partner hardware guidance](https://sonyinteractive.com/en/news/blog/complimentary-development-hardware/), [PlayStation Partners](https://partners.playstation.net/)

The current release admits no PlayStation SDK, approved application artifact or native API authority. The `console-playstation5-native` row offers no resources. System input, other titles, protected media and accounts remain unavailable. An approved application receiver would still need exact SDK, OS and device evidence before support could change.

## Xbox managed development and public PC GDK

Microsoft's ID@Xbox onboarding describes partner agreements and concept approval before full console access. The April 2026 release documentation distinguishes the console-capable GDK with Xbox extensions (GDKX) from the public GDK for Windows 10/11. A public PC GDK installation therefore supplies no console qualification. [ID@Xbox onboarding](https://learn.microsoft.com/en-us/gaming/game-publishing/onboarding/onboarding-join-id-at-xbox), [GDK release documentation](https://learn.microsoft.com/en-us/gaming/gdk/docs/gdk-dev/whatsnew/release-notes?view=gdk-2604)

The `console-xbox-gdk-native` row is unavailable in this release because no admitted GDKX receiver artifact or managed console authority exists in the release evidence. The desktop Windows implementation retains its own scope. It does not acquire Xbox system or game input by sharing Windows APIs.

## Xbox UWP and WebView2

Microsoft also documents a separate retail Developer Mode route for Xbox One and Series X|S. Its activation instructions require a valid Partner Center app developer account and console activation. Developer Mode runs development software separately from retail games and apps. That activation article is now under Microsoft's previous-version documentation; an owner must confirm the current enrollment and activation route before use. [Xbox Developer Mode activation](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/xbox-apps/devkit-activation)

Microsoft's WebView2 documentation, updated 3 August 2026 and checked again 18 October, describes an Xbox WinUI 2 UWP application, Developer Mode and Device Portal deployment. This establishes a documented receiver route distinct from GDKX. The `console-xbox-uwp-receiver` row remains a candidate because this release has no compiled Xbox UWP package, exact installed runtime or target receipt. [Xbox WebView2 documentation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-xbox)

The local receiver reuses existing authenticated manual WebRTC peers and pointer capability/consent contracts. It renders only its own surface after bilateral connection-code confirmation and a separate one-minute resource grant. Stop, cancellation, source disconnect and expiry release held input; the UWP host denies external navigation/new windows/downloads/browser permission requests and closes the WebView on native suspension, visibility loss, unload or process failure. Desktop browser checks exercise the actual RTC and application effect; expiry uses a controlled browser clock and visibility uses a synthetic event. UWP/API or WebView2 availability, native lifecycle and controller navigation still require the selected console build. Developer Mode is not permission to drive retail games or the console shell.

## Implementation and qualification requirements

The receiver can be built and served on local loopback with the existing repository tools; no new service or account is needed. Its Windows build path declares fixed UWP inputs, checks prerequisites and keeps compilation, installation and Xbox qualification separate. This Mac has no Windows UWP toolchain or activated Xbox target, and a local browser cannot emulate those target guarantees. No account registration, console activation, vendor agreement, SDK download or console modification was performed. The remaining native path is compilation with the declared Windows toolchain, followed by installation and qualification on an activated permitted target.

For each future admitted route, record the permitted application scope and exact hardware, OS build, SDK/toolchain, runtime, connector, profile and codec versions. Build and review the receiver, demonstrate source-to-application delivery through the real provider, and verify consent, denied/unsupported operations, clean release, reconnection and lifecycle behavior. Keep separate implementation, contract, runtime and physical receipts. Required Q04, Q08 and Q10 acceptance remains open.

The existing browser application receiver can be tested where an owner supplies a permitted browser with the necessary APIs. Local desktop browser tests prove only that desktop path. They do not qualify a console browser, UWP wrapper or native console API. Other closed platforms and unlisted versions inherit no support; they need an explicit permitted route and their own evidence.
