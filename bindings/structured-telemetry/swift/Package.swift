// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "One01StructuredTelemetryWire",
    platforms: [.macOS(.v14)],
    products: [.library(name: "One01StructuredTelemetryWire", targets: ["One01StructuredTelemetryWire"])],
    targets: [
        .target(name: "One01StructuredTelemetryWire"),
        .testTarget(name: "One01StructuredTelemetryWireTests", dependencies: ["One01StructuredTelemetryWire"])
    ]
)
