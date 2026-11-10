// swift-tools-version: 6.0

// PhaseLock's Swift client: the transport over HTTP, sessions, msgpack, the Swift walk of the
// generated type registry, and the host that runs the Engine in QuickJS through the native
// library built from native/, the C ABI binding of ../native.  On Apple's platforms the library is
// PhaseLockNative.xcframework, which native/build-xcframework.sh builds; on Linux it is the static
// library cargo builds there (`cargo build --release` in native/).  On Apple's platforms the
// package also carries the privacy manifest of everything it links into an app.

import PackageDescription

#if os(Linux)
let native: Target = .systemLibrary(name: "CPhaseLock", path: "native/include")
let nativeLinking: [LinkerSetting] = [
    .unsafeFlags(["-L", Context.packageDirectory + "/native/target/release"]),
    .linkedLibrary("dl"),
    .linkedLibrary("pthread"),
]
// the privacy manifest is for Apple's platforms alone
let unbundled = ["PrivacyInfo.xcprivacy"]
let resources: [Resource] = []
#else
let native: Target = .binaryTarget(name: "CPhaseLock", path: "native/PhaseLockNative.xcframework")
let nativeLinking: [LinkerSetting] = []
let unbundled: [String] = []
let resources: [Resource] = [.copy("PrivacyInfo.xcprivacy")]
#endif

let package = Package(
    name: "PhaseLock",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PhaseLock", targets: ["PhaseLock"]),
    ],
    targets: [
        native,
        .target(
            name: "PhaseLock",
            dependencies: ["CPhaseLock"],
            exclude: unbundled,
            resources: resources,
            linkerSettings: [.linkedLibrary("m")] + nativeLinking
        ),
        .testTarget(name: "PhaseLockTests", dependencies: ["PhaseLock"]),
    ]
)
