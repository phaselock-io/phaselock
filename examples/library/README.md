# PhaseLock `library` example

A simulated library (as in "the place where you check out books"), according to
[this domain description](https://github.com/ddd-by-examples/library).  A
library system offers many interesting race conditions, such as two
researchers simultaneously trying to reserve a restricted book, while a library
administrator is simultaneously demoting one of them from "researcher" to plain
"patron".

PhaseLock's architecture shines here.  Decisions are made in `precommit`
functions, plain functions expressing pure business logic.  Even challenging
distributed problems, which come up often in collaborative apps, are solved with
boring, testable code.

Additionally, this example shows how to get optimistic UI updates with no new
business logic, by refactoring your `precommit` functions into an authorization
step and an event generation function, then providing `forecaster` functions
that calls the event generation function.

This example markes optimistic updates as pending, so holds requested while
offline get a spinner until they resolve.  When `precommit` detects a conflict,
it also surfaces a notification message to the user.

## Architecture

In PhaseLock, optimistic updates are calculated by `forecaster` functions that
the Engine runs automatically for each outgoing command.  Your UI code does not
need to change at all.

```
(* = owned by user)
 ______________________________________________________
|  App                                                 |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | Engine                                        |  |
|       ___________           __________________       |
|   |  |           |       C |                  |   |  |
|      | *reducers |<------->|  store + overlay |      |
|   |  |___________|         |__________________|   |  |
|         ^ B    ^              ^         |            |
|   |     |      |              | H       | D       |  |
|         |    __|___________   |   ______v______      |
|   |     |   |              |  |  |             |  |  |
|         |   | *forecasters |  |  | query graph |     |
|   |     |   |______________|  |  |_____________|  |  |
|         |               ^     |    _ _ _|_ _ _ _ _   |
|   |     |               | G   |   |     | E          |
|       __|__________     |     |       __v___         |
|   |  |             | I  |     |   |  |      |        |
|      |  transport  |<---+-----+------| *UI  |        |
|   |  |_____________|            F |  |______|        |
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

- A: Transport talks to PhaseLockDB, reading events and writing commands.
- B: Events received by transport are passed to reducers.
- C: Reducers process incoming batches, updating store.
- D: Query graph wakes after store update and reruns queries whose dependencies have changed.
- E: Fresh query results are delivered to the UI.
- F: UI submits new commands with Engine.sendCommands(), triggering G, H, and I:
  - G: New commands trigger forecaster; forecasted events are reduced onto storage overlay.
  - H: New commands are also stored in an outbox in the store.
  - I: New commands are also sent through the transport.

## Run the example

Steps to run the example:

- ensure `docker` is available
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
