# PhaseLock `todo-basic` example

A very simple to-do app to illustrate:

- defining data types, mutations, and deciders
- adding a PhaseLock Engine to your app
- connecting live query results to your UI

The UI shows two separate Engines communicating through the database as two
collaborative clients would do.

## Architecture

The logical flow of information is circular:

- The app UI is populated by queries against the local store.
- User actions generate new mutations to send to PhaseLockDB.
- The decider validates mutations and updates server state.
- Those updates are captured as edits in a log.
- Edits from the log are streamed back to the client.
- Edits in the client are applied to the store.
- Live queries rerun when their inputs have changed, updating the app UI.

```
 ________________________________________
| todo-basic web app                     |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | PhaseLock Engine [4]            |  |
|       _________          _________     |
|   |  |      [1]|        |      [2]| |  |
|      |  store  |------->| queries |    |
|   |  |_________|        |_________| |  |
|         ^            _ _ _ _ _|_ _ _   |
|   |     |           |       __v___     |
|         |                  |   [3]|    |
|   |     |           |      |  UI  |    |
|         |                  |______|    |
|   |     |           |_ _ _ _ _|_ _ _   |
|       __|_____________________v___     |
|   |  |                         [4]| |  |
|      |         transport          |    |
|   |  |____________________________| |  |
|         ^                     |        |
|   |_ _ _|_ _ _ _ _ _ _ _ _ _ _|_ _ _|  |
|_________|_____________________|________|
          |                     |
          | edits               | mutations
    ______|_____________________|_____
   |  PhaseLockDB               |     |
   |  ____|_____           _____v___  |
   | |          |         |      [5]| |
   | | edit log |<--------| decider | |
   | |__________|         |_________| |
   |                                  |
   |__________________________________|
```

- [1] model/model.tsp defines store layouts and mutation types using TypeSpec
- [2] ui/src/Window.tsx defines queries in-line with the UI components
- [3] ui/src/useLocalQuery.ts defines the React hook for queries
- [4] ui/src/engines.ts starts an Engine+Transport pair that manages sync
- [5] model/db.ts defines the decider functions for processing mutations

## Run the example

Steps to run the example:

- ensure `docker` is available
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
