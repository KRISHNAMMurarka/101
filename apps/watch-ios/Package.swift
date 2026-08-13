// swift-tools-version: 6.0
import PackageDescription

// One01WatchCore holds every piece of watch logic that does not need a watch: the wire payload,
// the sampling policy and the link-state model. Keeping it platform-independent means it compiles
// and unit-tests on macOS in seconds, while the watchOS app target stays a thin shell around
// CoreMotion, WatchConnectivity and SwiftUI. See apps/watch-ios/README.md for the app target.
let package = Package(
    name: "One01Watch",
    platforms: [.watchOS(.v10), .iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "One01WatchCore", targets: ["One01WatchCore"]),
    ],
    targets: [
        .target(name: "One01WatchCore"),
        .testTarget(name: "One01WatchCoreTests", dependencies: ["One01WatchCore"]),
    ]
)
