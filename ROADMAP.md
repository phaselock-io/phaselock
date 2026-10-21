# PhaseLock Roadmap

PhaseLock is currently in Alpha.  All the core sync engine features are
implemented, the database is still in draft form, and nothing is properly
documented.

There's still a lot to do:

- PhaseLockDB: the real thing
  - use a custom log plus LMDB for key-value storage
  - add view-stamped replication (revisited) for HA between nodes

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

- Reimplement old go and python bindings to match the latest Engine patterns:
  - No more JS wrapper types; native types should be fully-native
  - Native queries read native types directly from storage, no JS layer
  - Provide a type registry to the Engine for conversions

- Support new languages, starting with Kotlin and Swift

- Additional frontend demos:
  - React Native
  - iOS
  - Android
  - PhaseLock + OPFS serving one or more tabs with durable storage

- Add indices to PhaseLock
  - automatically maintained in either database or Engine
  - available to both queries and decider/predictors
  - in-mem indices should be possible
  - on-disk indices should be possible, as subtree of KV store

- Additional plugins
  - email plugin
  - signed webhook plugin
  - payment provider integrations
  - timers

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
