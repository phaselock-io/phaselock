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
- The connector streams events from PhaseLockDB to Engine.
- The Engine processes events with reducers to populate the store.
- The app submits queries to read the store.
- The app feeds live query results to a reactive UI.
- User actions generate commands to send to PhaseLockDB.
- Precommit validates commands and generates new events for the event log.
- PhaseLockDB emits fresh events, and the cycle continues.

```
 __________________________________________
| todo-basic web app                       |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | PhaseLock Engine [5]              |  |
|       _________           _________      |
|   |  |      [1]|         |      [3]|  |  |
|      |  store  |-------->| queries |     |
|   |  |_________|         |_________|  |  |
|         ^            _ _ _ _ _|_ _ _ _   |
|   |   __|_______    |         |          |
|      |       [2]|           __v___       |
|   |  | reducers |   |      |   [4]|      |
|      |__________|          |  UI  |      |
|   |_ _ _^_ _ _ _ _ _|      |______|      |
|         |                     |          |
|   ______|_____________________v_______   |
|  |                                    |  |
|  |           connector [5]            |  |
|  |____________________________________|  |
|_________^_____________________|__________|
          |                     |
          | events              | commands
    ______|_____________________v_______
   |  PhaseLockDB                       |
   |  ____|______         ___________   |
   | |        [1]|       |        [6]|  |
   | | event log |<------| precommit |  |
   | |___________|       |___________|  |
   |                                    |
   |____________________________________|
```

- [1] model/model.tsp defines event types and store layouts using TypeSpec
- [2] model/reducers.ts defines reducer functions that build state from events
- [3] ui/src/Window.tsx defines queries in-line with the UI components
- [4] ui/src/useLocalQuery.ts defines the React hook for queries
- [5] ui/src/engines.ts starts an Engine+Connector pair that manages sync
- [6] model/db.ts defines the precommit function for processing commands

## Run the example

Steps to run the example:

- ensure `docker` is available
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
