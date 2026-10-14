# Building needs only Go and a C compiler: cgo compiles the core and the vendored libraries
# (core.go), and `go install phaselock.io/phaselockdb@latest` works the same way.  QuickJS's
# -fwrapv is outside cgo's default flag allowlist, hence the variable.
export CGO_CFLAGS_ALLOW = -fwrapv

all:
	go build -o phaselockdb .

# the test bundle: the test model through the TypeScript emitter, bundled with its user code and
# @phaselock/plugins.  It is rebuilt on every test run, the emitter and the plugins with it, so it
# never lags their sources.
BUNDLE = testdata/bundle.js

testdata/node_modules: testdata/package.json
	cd testdata && pnpm install --prefer-offline && touch node_modules

../plugins/node_modules: ../plugins/package.json
	cd ../plugins && pnpm install --prefer-offline && touch node_modules

bundle: testdata/node_modules ../plugins/node_modules
	cd ../typespec && pnpm build
	cd ../plugins && pnpm build
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
