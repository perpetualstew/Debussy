// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Debussy",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Debussy", targets: ["Debussy"])],
    targets: [.executableTarget(name: "Debussy", path: "Sources/Debussy")]
)
