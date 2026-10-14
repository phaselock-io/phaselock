# The database, built by Go alone: cgo compiles the C core and the vendored libraries (core.go).
# The image holds no app: run it with a bundle mounted and a data directory to keep.
#
#   docker build -t phaselockdb db
#   docker run -p 8080:8080 -v "$PWD/bundle.js:/bundle.js:ro" -v "$PWD/data:/data" \
#     phaselockdb --bundle /bundle.js

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY . .
# The build cache and the module cache persist across image builds as cache mounts, so a rebuild
# compiles only the packages that changed.  QuickJS's -fwrapv is outside cgo's default flag
# allowlist.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_CFLAGS_ALLOW=-fwrapv go build -trimpath -o /phaselockdb .

FROM debian:bookworm-slim
COPY --from=build /phaselockdb /usr/local/bin/phaselockdb
EXPOSE 8080
ENTRYPOINT ["phaselockdb", "--data", "/data", "--listen", "0.0.0.0:8080"]
