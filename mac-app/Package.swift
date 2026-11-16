// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PianoLibraryMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "PianoLibraryMac", targets: ["PianoLibraryMac"]), .library(name: "ScoreCore", targets: ["ScoreCore"])],
    targets: [
        .target(name: "ScoreCore"),
        .executableTarget(name: "PianoLibraryMac", dependencies: ["ScoreCore"], resources: [.copy("Resources")]),
        .testTarget(name: "ScoreCoreTests", dependencies: ["ScoreCore"])
    ]
)
