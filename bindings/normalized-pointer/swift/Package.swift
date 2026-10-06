// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "One01PointerWire",
    platforms: [.macOS(.v14)],
    products: [.library(name: "One01PointerWire", targets: ["One01PointerWire"])],
    targets: [
        .target(name: "One01PointerWire"),
        .testTarget(name: "One01PointerWireTests", dependencies: ["One01PointerWire"])
    ]
)
