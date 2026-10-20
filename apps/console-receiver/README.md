# Local console application receiver

This is an authored application surface and a WinUI 2 UWP host candidate for Xbox
Developer Mode. The receiver implementation works in supported desktop browsers.
Windows compilation, Xbox installation, the installed WebView2 version, console
navigation and physical target qualification remain unverified. Its existence
does not close N11 or grant control of the Xbox shell, another title, protected
media or accounts.

## Run locally

From the repository root, using the existing installed dependencies:

```sh
node apps/console-receiver/build.mjs
node apps/console-receiver/serve.mjs
```

The second command serves only the built application on loopback port 4177. Open
the local address it prints. Stop that process with Ctrl+C. `RECEIVER_PORT` may
select another unprivileged port. No relay, service account or external website
is used. The bundle, generated monochrome package marks and source/artifact hash
manifest are under `release/console-receiver/`; they are generated output.

Choose **Create invitation**. On an existing 101 pointer controller (the browser
Pointer lab in its Send pointer role, or the native phone pointer controller),
paste and review that invitation. Its application must be
`101-console-pointer-surface`; its session starts `console-`. Transfer the
controller's complete offer to the receiver, and the receiver's complete answer
back to the controller. Compare the full connection code directly on both
screens and let each owner allow the connection. Finally choose **Allow pointer
for one minute** on the receiver. Touch or keyboard pointer input then changes
only this application's surface.

**Stop**, **Cancel request**, hidden-page events, lost connection or expiry release
the surface and close its peer. Recovery always needs a fresh invitation. No
resource is allowed by an invitation, network connection or code comparison
alone. The receiver uses a session-only, nonextractable WebCrypto key; it saves no
identity or permanent grant. The provider and receiver negotiate the existing
pointer capability contract, including rate, freshness, ownership and release.
The grant lasts at most one minute. Native browser RTC uses DTLS and the existing
endpoint authentication; there is no STUN or TURN service, so a reachable direct
network path is required.

## UWP source and build path

`windows/Receiver.csproj` contains the actual XAML host and application manifest.
It maps bundled `Web/` content to the fixed local origin
`https://101-receiver.invalid/index.html`; this is a WebView2 local folder mapping,
not a domain to register or fetch. The host blocks other navigation, new windows,
downloads and browser permission requests. It exposes no native message bridge.
The declared network capabilities permit the app's direct connection; camera,
microphone, location, input injection and broad file access are absent.

The host closes the complete WebView on **Stop receiver**, visibility loss,
suspension, process failure and unload. Returning or resuming does not reopen it;
**Open receiver** creates a fresh browser instance and the page still needs a new
invitation and approvals. Native keyboard controls remain available. Xbox gamepad
focus, text transfer and controller navigation require an actual target check.

The explicit baseline matches Microsoft's public WinUI2 getting-started source:
Windows SDK `10.0.22000.0`, minimum OS `10.0.17763.0`,
`Microsoft.NETCore.UniversalWindowsPlatform` `6.2.14` and `Microsoft.UI.Xaml`
`2.8.2`. These are declared build inputs, not a claim that dependencies are
installed or that they qualify a target. No SDK was downloaded here.

On an available Windows machine with Visual Studio's UWP/XAML tooling, after the
web build above, run:

```powershell
powershell -ExecutionPolicy Bypass -File apps/console-receiver/windows/build.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File apps/console-receiver/windows/build.ps1 -Restore
```

The first command only reports prerequisites, including running the same Node
bundle verifier used by the build. It rejects a missing or stale producer
manifest, changed source or bundle bytes, unsafe paths, unlisted artifacts and
symbolic links. The manifest pins the verifier itself. The second explicitly restores the
declared NuGet dependencies and builds an unsigned x64 sideload package by
default. It never installs anything or changes console settings. To build a
signed package, supply `-SigningThumbprint` for an existing Windows signing
certificate whose subject matches the manifest publisher. No signing key,
certificate installation, account activation or target authority is invented.
Each invocation creates a new GUID directory for its intermediate, binary and
package outputs under `release/console-receiver/windows/`. Before and after
MSBuild, it verifies the current manifest, source and bundle and requires the
same input pins. A successful receipt hashes packages from only that invocation;
an old package directory cannot satisfy it. It keeps `installed: false` and
`xboxQualified: false`. The receipt stays inside that invocation's directory.

## Verification and remaining qualification

```sh
node --experimental-strip-types --test tests/console-receiver.test.ts
node --experimental-strip-types --test tests/console-receiver-bundle.test.ts
node apps/console-receiver/verify-bundle.mjs
node tools/qa-console-receiver.mjs
```

The browser check builds production source, records its actual source closure and
bundle hashes, then uses two real local desktop pages with native RTC and crypto.
It checks both owners' comparison, independent resource consent, actual pointer
movement/contact, stop, reconnect, invalid offer, cancellation, expiry, hidden
page release, keyboard operation and narrow layout. Expiry checks advance the
Playwright clock. The visibility check shadows `document.hidden` and dispatches a
synthetic `visibilitychange` event. These verify the clock and event handlers;
they do not demonstrate natural-time waiting or native OS/console suspension.
The check closes its server,
contexts and browsers. Its separate QA controller is never included in the
production application bundle. Receipts and screenshots are under
`outputs/controllers/2026-10-18-console-receiver/`.

To qualify Xbox later, retain the exact console model/OS, activated development
target, installed package hash, Windows build receipt, WebView2 runtime, direct
network path and source/controller versions. Run the same permission matrix on
that target, including held input on source disconnect, console suspend/resume,
native Stop/reopen, denied browser permissions, navigation rejection, invitation
and grant expiry, and controller-only focus/text transfer. Keep runtime and
physical receipts separate from desktop browser checks.

Primary Microsoft references checked 18 October 2026:

- [Xbox UWP WebView2 route](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/remote-debugging-xbox)
- [WinUI 2 setup](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winui2)
- [Microsoft's baseline project](https://github.com/MicrosoftEdge/WebView2Samples/blob/main/GettingStartedGuides/WinUI2_GettingStarted/MyUWPGetStartApp/MyUWPGetStartApp.csproj)
- [Local HTTPS folder mapping](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content)
- [UWP WebView2 limitations](https://learn.microsoft.com/en-us/microsoft-edge/webview2/platforms/winui2-uwp)
