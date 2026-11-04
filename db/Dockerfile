# The database, built by cargo alone: ../core's build.rs compiles the vendored QuickJS, and every
# other dependency is a crate.  The image holds no app: run it with a bundle mounted and a data
# directory to keep.  It builds from the repo's root, since the crate depends on ../core.
#
#   docker build -t phaselockdb -f db/Dockerfile .
#   docker run -p 8080:8080 -v "$PWD/bundle.js:/bundle.js:ro" -v "$PWD/data:/data" \
#     phaselockdb --bundle /bundle.js

FROM rust:1-bookworm AS build
WORKDIR /src
COPY core core
COPY db db
# The crate registry and the build directory persist across image builds as cache mounts, so a
# rebuild compiles only what changed; the binary is copied out of the cached build directory.
WORKDIR /src/db
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/db/target \
    cargo build --release --locked && cp target/release/phaselockdb /phaselockdb

FROM debian:bookworm-slim
COPY --from=build /phaselockdb /usr/local/bin/phaselockdb
EXPOSE 8080
ENTRYPOINT ["phaselockdb", "--data", "/data", "--listen", "0.0.0.0:8080"]
