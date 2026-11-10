#!/bin/sh
# Makes everything the app's build reads, on a Mac: the model's generated code and its native
# bundles, the native library as an XCFramework, and the Xcode project.  Needs pnpm, the Rust
# targets build-xcframework.sh names, and XcodeGen.

set -e
cd "$(dirname "$0")"
(cd ../model && pnpm gen && pnpm bundle:native:dev && pnpm bundle:native)
../../../client/swift/native/build-xcframework.sh
xcodegen generate
