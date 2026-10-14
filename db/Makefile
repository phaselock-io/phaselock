# Building needs only Go and a C compiler: cgo compiles the core and the vendored libraries
# (core.go), and `go install phaselock.io/phaselockdb@latest` works the same way.  QuickJS's
# -fwrapv is outside cgo's default flag allowlist, hence the variable.
export CGO_CFLAGS_ALLOW = -fwrapv

all:
	go build -o phaselockdb .

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

test: bundle
	go test -count=1 ./...

# our own C with warnings as errors, which a cgo build leaves off; shim.c includes a header cgo
# generates
check:
	@for f in *.c; do \
	  case $$f in shim.c) ;; *) $(CC) -fsyntax-only $$(cat compile_flags.txt) -Werror $$f || exit 1;; esac; \
	done

clean:
	rm -f phaselockdb $(BUNDLE) testdata/bundle.prod.js testdata/model.gen.ts

.PHONY: all bundle test check clean
