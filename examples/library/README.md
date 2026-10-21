# PhaseLock `library` example

A simulated library (as in "the place where you check out books"), according to
[this domain description](https://github.com/ddd-by-examples/library).  A
library system offers many interesting race conditions, such as two
researchers simultaneously trying to reserve a restricted book, while a library
administrator is simultaneously demoting one of them from "researcher" to plain
"patron".

PhaseLock's architecture shines here.  Decider functions are plain functions
expressing pure business logic.  Even challenging distributed problems, which
come up often in collaborative apps, are solved with boring, testable code.

Additionally, this example shows how to get optimistic UI updates with no new
business logic, by refactoring your decider functions into an authorization
step and a mutation handler.  Typically the mutation handler is exactly your
predictor function, since the predictor does the same job as the decider but
without the authorization check.

This example marks optimistic updates as pending, so holds requested while
offline get a spinner until they resolve.  When the decider detects a conflict,
it also surfaces a notification message to the user.

This example include a concept of a "room" so it can be hosted as a shared demo
at [demo.phaselock.io](https://demo.phaselock.io).

## Architecture

In PhaseLock, optimistic updates are calculated by predictor functions that
the Engine runs automatically for each outgoing mutation.  Your UI code does not
need to change at all.

```
(* = owned by user)
 ______________________________________________________
|  App                                                 |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | Engine                                        |  |
|       ________________________________________       |
|   |  |                                        |   |  |
|      |              store + overlay           |      |
|   |  |________________________________________|   |  |
|         ^ B    ^              ^         |            |
|   |     |      |              | G       | C       |  |
|         |    __|__________    |   ______v______      |
|   |     |   |             |   |  |             |  |  |
|         |   | *predictors |   |  | query graph |     |
|   |     |   |_____________|   |  |_____________|  |  |
|         |               ^     |    _ _ _|_ _ _ _ _   |
|   |     |               | F   |   |     | D          |
|       __|__________     |     |       __v___         |
|   |  |             | H  |     |   |  |      |        |
|      |  transport  |<---+-----+------| *UI  |        |
|   |  |_____________|            E |  |______|        |
|           ^                                          |
|   |_ _ _ _|_ _ _ _ _ _ _ _ _ _ _ _|                  |
|___________|__________________________________________|
            |
            | A
       _____v_______
      |             |
      | PhaseLockDB |
      |_____________|
```

- A: Transport talks to PhaseLockDB, reading edits and writing mutations.
- B: Edits received by transport are applied to the store.
- C: Query graph wakes on store update and reruns queries whose dependencies have changed.
- D: Fresh query results are delivered to the UI.
- E: UI submits new mutations with Engine.sendMutation(), triggering F, G, and H:
  - F: New mutations trigger predictor; predicted edits land in the storage overlay.
  - G: New mutations are also stored in an outbox in the store.
  - H: New mutations are also sent through the transport.

## Run the example

Steps to run the example:

- ensure `docker` is available
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
