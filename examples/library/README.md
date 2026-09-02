# PhaseLock `library` example

A simulated library (as in "the place where you check out books"), according to
[this domain description](https://github.com/ddd-by-examples/library).  A
library system offers many interesting race conditions, such as two
researchers simultaneously trying to reserve a restricted book, while a library
administrator is simultaneously demoting one of them from "researcher" to plain
"patron".

The reducer pattern in PhaseLock shines here.  Reducers are plain functions
expressing pure business logic, so even challenging distributed problems, which
come up often in collaborative apps, are solved with boring, testable code.

Additionally, this example shows:
- offline-capable UIs with optimistic updates
- a backend worker that uses PhaseLock for resolving conflicts
- a relay that sanitizes events for the client
- a relay that uses PhaseLock to semantically validate commands
- cross-language packaging of a PhaseLock data model into Go and Python

## Frontend diagram, with optimistic updates

In PhaseLock, optimistic updates require you to write a "forecaster" function
that predicts what event(s) the server will emit for each command.  PhaseLock
handles the rest: it runs your forecasted events through your reducers, tracking
updates in a disposable store overlay, and discards the overlay when the real
results arrive.  Your UI updates optimistically with no additional effort.

```
 ______________________________________________________
|  PWA                                                 |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | engine                                        |  |
|       ___________           ____________________     |
|   |  |           |       C |                    | |  |
|      |  reducers |<------->|  store + overlay   |    |
|   |  |___________|         |____________________| |  |
|         ^ B    ^              ^         |            |
|   |     |      |              |         | D       |  |
|         |     _|___________   |   ______v______      |
|   |     |    |             |  |  |             |  |  |
|         |    | forecasters |  |  | query graph |     |
|   |     |    |_____________|  |  |_____________|  |  |
|         |             ^ G     |         |            |
|   |     |         I   |     H |         |         |  |
|         |       +-----+-------+         |            |
|   |_ _ _|_ _ _ _|_ _ _^_ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
|         |       |     |                 | E          |
|       __|_______v__   |              ___v__          |
|      |             |  | F           |      |         |
|      |  websocket  |  +-------------|  UI  |         |
|      |_____________|                |______|         |
|            ^ A                                       |
|____________|_________________________________________|
             |
        _____v______
       |            |
       |    relay   |
       |____________|
             ^
             |
        _____v______
       |            |
       | KurrentDB  |
       |____________|
```

- A: Websocket talks to relay, reading events, writing commands, and handling disconnects
- B: Websocket calls Engine.recvEvents() on new events, which triggers reducers
- C: Reducers process incoming batches, updating store
- D: Query graph wakes after store update and reruns queries whose dependencies have changed
- E: Fresh query results are delivered to the UI
- F: UI submits new commands with Engine.sendCommands(), triggering G, H, and I:
  - G: New commands trigger forecaster; forecasted events are reduced onto overlay
  - H: New commands are also stored in an outbox in the store
  - I: New commands also trigger the user's onCommands() hook so they can be sent over websocket

## Backend diagram, with a decider

In a collaborative app, it is important to capture the human effort first
(saving it to the event log) and resolve conflicts afterwards.  Think of it
like `git`: you wouldn't want your PR deleted just because you had a conflict.

There are two ways in PhaseLock to implement that: one is at read time, in the
reducer, and the other is with a dedicated backend worker, which we call a
"decider".  In this library example, it turns out that resolving a `TryHold`
race between two patrons requires near-global read access, which individual
patrons can't have.  So this example uses a decider that emits explicit decision
events that patrons can read.

Note that the relay shown here scales horizontally, but the decider needs to
have at most one runner at a time.  To scale it, you'd need to shard its
responsibility (and you'd still have at-most-one runner mechanics within each
shard).

```
               ____________________________________________
             _|__________________________________________  |
           _|__________________________________________  | |
          |                                            | |_|
          |                  clients                   |_|
          |____________________________________________|
              ^                                   |
              | events                            | commands
 _____________|___________________________________|____________
| Relay       |                                   |            |
|     ________|___________________________________v____        |
|    |                                                 |       |
|    |                  websockets                     |       |
|    |_________________________________________________|       |
|             ^                                   |            |
|      _______|_________                  ________v_____       |
|     |                 |                |              |      |
|     | incoming stream |                | authn checks |      |
|     |_________________|                |______________|      |
|             ^                                   |            |
|_____________|___________________________________|____________|
              |                                   |
 _____________|___________________________________v____________
|                                                              |
|                         KurrentDB                            |
|______________________________________________________________|
              ^                                   |
 _____________|___________________________________|____________
| Decider     |                                   |            |
|             |                          _________v________    |
|             | outgoing                |                  |   |
|             | decision                | committed events |   |
|             | events                  |__________________|   |
|             |                                   |            |
|  _ _ _ _ _ _|_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _|_ _ _ _ _   |
| | engine    |                                   |         |  |
|       ______|______       _________       ______v___         |
| |    |             |     |         |     |          |     |  |
|      | query graph |<----|  store  |<--->| reducers |        |
| |    |_____________|     |_________|     |__________|     |  |
|                                                              |
| |_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _|  |
|______________________________________________________________|
```

## Run the example

Steps to run the example:

- ensure `docker` is available (to run KurrentDB locally)
- ensure `go` is installed (for decider/)
- ensure `python3` is installed, plus python-dev headers, plus a C compiler
- install npm dependencies: `pnpm i`
- install pip dependencies in a virtual env:
  - `python3 -m venv .venv`
  - `source .venv/bin/activate`
  - `python3 -m pip install aiohttp kurrentdbclient lmdb`
- build everything: `make`
- run the demo: `make dev`
- visit `http://localhost:3000` in your browser
