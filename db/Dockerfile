# The database, built by cargo alone: build.rs compiles the vendored QuickJS, and every other
# dependency is a crate.  The image holds no app: run it with a bundle mounted and a data
# directory to keep.
#
#   docker build -t phaselockdb db
#   docker run -p 8080:8080 -v "$PWD/bundle.js:/bundle.js:ro" -v "$PWD/data:/data" \
#     phaselockdb --bundle /bundle.js

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# The crate registry and the build directory persist across image builds as cache mounts, so a
# rebuild compiles only what changed; the binary is copied out of the cached build directory.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/phaselockdb /phaselockdb

FROM debian:bookworm-slim
COPY --from=build /phaselockdb /usr/local/bin/phaselockdb
EXPOSE 8080
ENTRYPOINT ["phaselockdb", "--data", "/data", "--listen", "0.0.0.0:8080"]
