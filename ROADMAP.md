# PhaseLock Roadmap

PhaseLock is currently in Alpha.  All the core features are implemented, a few
of them are tested, and none of them are properly documented.

There's still a lot to do:

- Documentation for:
  - the TypeSpec API
  - the TypeSpec emitter configuration (per-language)
  - the generated APIs (per language)
  - recommended backend architecture(s)

- Support aliases in TypeSpec... today they cause confusing/broken generated code.

- Reimplement go and python bindings to match new cross-language plan:
  - No more JS wrapper types; native types should be fully-native
  - Native queries read native types directly from storage, no JS layer
  - Generate type registry per framework for handling conversions
  - StoreGenerator redesign around the type registry
  - Eliminate "plain-json object" as central type in Engine API.

- Support additional languages, starting with Kotlin and Swift

- Additional frontend demos:
  - React Native
  - iOS
  - Android
  - PhaseLock engine in a Shared Worker serving multiple tabs

- Additional backend demos:
  - Pure TypeScript backend for library demo
  - Cloudflare CDN-based log distribution
  - Cloudflare CDN-based server-side queries
    - Will require implementing a Store MVCC capability

- Add indices as a formal concept in the PhaseLock Engine
  - possibly a plugin interface, for define-your-own index?
  - include a btree implementation at a minimum

- Add support for time-based triggers
  - reducers currently only wake due to events
  - currently unable to be triggered by passage of time
  - user workaround is possible (Tick events and a query for wakeups)
  - ought to be first-class in PhaseLock
  - will require careful consideration: how will it interact with catchup and replay?

- Performance testing
  - Test various backend designs for read/write throughput and round trip latency.
  - Bottleneck analysis and optimization.
  - How do different designs scale, especially on the read side?
  - Use this data to pick recommended backend architecture(s).

- Investigate snapshot tooling
  - Snapshots can greatly reduce cold-start times
  - Snapshots may require per-user sanitization
  - How can we offer tooling to make this easier?
