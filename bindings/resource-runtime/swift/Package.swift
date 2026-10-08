// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "One01ResourceRss",
    platforms: [.macOS(.v14)],
    products: [.library(name: "One01ResourceRss", targets: ["One01ResourceRss"]),
               .executable(name: "One01ResourceRssCaller", targets: ["One01ResourceRssCaller"])],
    targets: [
        .target(name: "One01ResourceRss"),
        .executableTarget(name: "One01ResourceRssCaller", dependencies: ["One01ResourceRss"]),
        .testTarget(name: "One01ResourceRssTests", dependencies: ["One01ResourceRss"], resources: [.process("Fixtures")])
    ]
)
