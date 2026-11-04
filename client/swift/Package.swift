// swift-tools-version: 6.0

// PhaseLock's Swift client: the transport over HTTP, sessions, msgpack, the Swift walk of the
// generated type registry, and the host that runs the Engine in QuickJS through the native
// library built from native/, the C ABI binding of ../native.  On Linux the library links the
// static library cargo builds there (`cargo build --release` in native/).

import PackageDescription

let native = Context.packageDirectory + "/native/target/release"

let package = Package(
    name: "PhaseLock",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PhaseLock", targets: ["PhaseLock"]),
    ],
    targets: [
        .systemLibrary(name: "CPhaseLock", path: "native/include"),
        .target(
            name: "PhaseLock",
            dependencies: ["CPhaseLock"],
            linkerSettings: [
                .unsafeFlags(["-L", native]),
                .linkedLibrary("m"),
                .linkedLibrary("dl", .when(platforms: [.linux])),
                .linkedLibrary("pthread", .when(platforms: [.linux])),
            ]
        ),
        .testTarget(name: "PhaseLockTests", dependencies: ["PhaseLock"]),
    ]
)
