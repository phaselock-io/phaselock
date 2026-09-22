# PhaseLock Roadmap

PhaseLock is currently in Alpha.  All the core sync engine features are
implemented, a few of them are tested, and none of them are properly
documented.

There's still a lot to do:

- PhaseLockDB: the whole backend in a process
  - user-defined plugins embed backend behaviors in the db:
    - lookup() function to define authN
    - maySee() to implement read-side autZ
    - precommit() to implement the write path
  - eventually view-stamped replication (revisited) for HA between nodes

- PhaseLock cloud
  - hosted PhaseLockDB instances
  - hosted side-effects (sending email, sending/receiving webhooks, etc)
  - free tier with auto-hibernation and periodic backups
  - paid tier with HA and resource reservations

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
