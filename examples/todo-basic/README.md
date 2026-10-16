# PhaseLock `todo-basic` example

A very simple to-do app to illustrate:

- defining data types, reducers, and precommit
- adding a PhaseLock Engine to your app
- connecting live query results to your UI

The UI shows two separate Engines communicating through the database as two
collaborative clients would do.

## Architecture

The logical flow of information is circular:

- PhaseLockDB stores events in a log.
- The transport streams events from PhaseLockDB to Engine.
- The Engine processes events with reducers to populate the store.
- The app submits queries to read the store.
- The app feeds live query results to a reactive UI.
- User actions generate commands to send to PhaseLockDB.
- Precommit validates commands and generates new events for the event log.
- PhaseLockDB emits fresh events, and the cycle continues.

```
 ________________________________________
| todo-basic web app                     |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | PhaseLock Engine [5]            |  |
|       _________          _________     |
|   |  |      [1]|        |      [3]| |  |
|      |  store  |------->| queries |    |
|   |  |_________|        |_________| |  |
|         ^            _ _ _ _ _|_ _ _   |
|   |   __|_______    |       __v___     |
|      |       [2]|          |   [4]|    |
|   |  | reducers |   |      |  UI  |    |
|      |__________|          |______|    |
|   |     ^           |_ _ _ _ _|_ _ _   |
|       __|_____________________v___     |
|   |  |                            | |  |
|      |         transport          |    |
|   |  |____________________________| |  |
|         ^                     |        |
|   |_ _ _|_ _ _ _ _ _ _ _ _ _ _|_ _ _|  |
|_________|_____________________|________|
          |                     |
          | events              | commands
    ______|_____________________|_____
   |  PhaseLockDB               |     |
   |  ____|______        _______v___  |
   | |        [1]|      |        [6]| |
   | | event log |<-----| precommit | |
   | |___________|      |___________| |
   |                                  |
   |__________________________________|
```

- [1] model/model.tsp defines event types and store layouts using TypeSpec
- [2] model/reducers.ts defines reducer functions that build state from events
- [3] ui/src/Window.tsx defines queries in-line with the UI components
- [4] ui/src/useLocalQuery.ts defines the React hook for queries
- [5] ui/src/engines.ts starts an Engine+Transport pair that manages sync
- [6] model/db.ts defines the precommit function for processing commands

## Run the example

Steps to run the example:

- ensure `docker` is available
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
