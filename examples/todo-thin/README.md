# PhaseLock `todo-thin` example

This example builds on the [todo-basic][basic] example by adding Query
definitions to the data model.  This unlocks the ability to power the _exact
same UI_ but with the PhaseLock Engine now running in the server.

[basic]: https://github.com/phaselock-io/phaselock/tree/master/examples/todo-basic


## Architecture

The logical flow of information is circular:

- KurrentDB stores events.
- The server feeds fresh events to its PhaseLock Engine.
- The server pushes updated query results to clients.
- Clients update their UI with fresh data.
- User actions generate commands to send to the server.
- The server validates commands and writes new events to KurrentDB.
- KurrentDB emits fresh events, the cycle continues.

```
 ______________________________________
|                                      |
|           todo-thin web app [3]      |
|______________________________________|
           ^                 |
           | query results   | commands
 __________|_________________|_________
| server   |                 |         |
|   _ _ _ _|_ _ _ _ _ _      |         |
|  | PhaseLock Engine  |     |         |
|        __|______           |         |
|  |    |      [4]|    |     |         |
|       | queries |          |         |
|  |    |_________|    |     |         |
|        _________           |         |
|  |    |      [1]|    |     |         |
|       |  store  |          |         |
|  |    |_________|    |     |         |
|        _________           |         |
|  |    |      [2]|    |     |         |
|       | reducer |          |         |
|  |    |_________|    |     |         |
|          ^                 |         |
|  |_ _ _ _|_ _ _ _ _ _|     |         |
|__________|_________________|_________|
           |                 |
           | events          | commands
 __________|_________________v_________
|                                      |
|             KurrentDB [1]            |
|______________________________________|
```

- [1] model/model.tsp defines event and query types and store layout using TypeSpec
- [2] model/reducers.ts defines reducer functions that build state from events
- [3] ui/src/usePhaseLock.ts connects to the server and provides remote queries
- [4] server/main.ts implements the queries and sends results over the wire

## Run the example

Steps to run the example:

- ensure `docker` is available (to run KurrentDB locally)
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
