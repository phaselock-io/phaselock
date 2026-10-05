all: core/libpldb.a
	cd server && go build -o ../pldb .

core/libpldb.a: $(wildcard core/*.c core/*.h core/host.js)
	$(MAKE) -C core

# the test bundle: the test model through the TypeScript emitter, bundled with its user code.
# It is rebuilt on every test run, the emitter with it, so it never lags the typespec sources.
BUNDLE = server/testdata/bundle.js

server/testdata/node_modules: server/testdata/package.json
	cd server/testdata && pnpm install --prefer-offline && touch node_modules

bundle: server/testdata/node_modules
	cd ../typespec && pnpm build
	cd server/testdata && pnpm gen

test: core/libpldb.a bundle
	cd server && go test -count=1 ./...

clean:
	$(MAKE) -C core clean
	rm -f pldb $(BUNDLE) server/testdata/bundle.prod.js server/testdata/model.gen.ts

.PHONY: all bundle test clean
