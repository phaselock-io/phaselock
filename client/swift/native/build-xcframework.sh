#!/bin/sh
# Builds the native library for every Apple platform the Swift package runs on, iOS devices, the
# iOS simulator, and macOS, all on Apple silicon, and wraps the three static libraries with the C
# header and module map as PhaseLockNative.xcframework, which Package.swift links on Apple.  Run it
# on a Mac with the Rust targets aarch64-apple-ios, aarch64-apple-ios-sim, and aarch64-apple-darwin.

set -e
cd "$(dirname "$0")"

# each target's deployment version, which the Rust objects are built for, as the package's are
export IPHONEOS_DEPLOYMENT_TARGET=17.0
export MACOSX_DEPLOYMENT_TARGET=14.0

for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin; do
    cargo build --release --target "$target"
done

rm -rf PhaseLockNative.xcframework
xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/libphaselock_swift.a -headers include \
    -library target/aarch64-apple-ios-sim/release/libphaselock_swift.a -headers include \
    -library target/aarch64-apple-darwin/release/libphaselock_swift.a -headers include \
    -output PhaseLockNative.xcframework
