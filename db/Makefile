# Building needs only a Rust toolchain and a C compiler: build.rs compiles the vendored QuickJS,
# and every other dependency is a crate.

all:
	cargo build --release

# the test bundle: the test model through the TypeScript emitter, bundled with its user code and
# @phaselock/plugins.  It is rebuilt on every test run from the emitter's and the plugins' sources,
# so it never lags them.
BUNDLE = testdata/bundle.js

# the test bundle's package and the workspace packages it depends on, from the repo's workspace
testdata/node_modules: testdata/package.json ../plugins/package.json
	cd testdata && pnpm install --prefer-offline --filter '@phaselock/phaselockdb-testdata...' \
	  && touch node_modules

bundle: testdata/node_modules
	cd testdata && pnpm gen

# the unit tests and the feature tests
test: bundle
	cargo test --release

clean:
	cargo clean
	rm -f $(BUNDLE) testdata/bundle.prod.js testdata/model.gen.ts

.PHONY: all bundle test clean
