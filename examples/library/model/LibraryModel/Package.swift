// swift-tools-version: 6.0

// The library model's Swift: the code @phaselock/typespec-swift generates from ../model.tsp
// (`pnpm gen` in ..), over PhaseLock's Swift client, and its tests, which run against the
// model's native bundle and the database.

import PackageDescription

let package = Package(
    name: "LibraryModel",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LibraryModel", targets: ["LibraryModel"]),
    ],
    dependencies: [
        .package(path: "../../../../client/swift"),
    ],
    targets: [
        .target(name: "LibraryModel", dependencies: [.product(name: "PhaseLock", package: "swift")]),
        .testTarget(
            name: "LibraryModelTests",
            dependencies: ["LibraryModel", .product(name: "PhaseLock", package: "swift")]
        ),
    ]
)
