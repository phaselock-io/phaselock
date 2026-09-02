# PhaseLock `todo-basic` example

A very simple to-do app to illustrate:

- defining data types and reducers
- streaming events from KurrentDB to a client-side PhaseLock Engine
- connecting live query results to your UI

## Architecture

The logical flow of information is circular:

- KurrentDB stores events.
- The server relays events from db to ui.
- The web app feeds events to the PhaseLock Engine.
- The UI queries PhaseLock for state.
- The UI feeds live query results to a reactive UI.
- User actions generate commands to send to the server.
- The server validates commands and writes new events to KurrentDB.
- KurrentDB emits fresh events, the cycle continues.

```
 __________________________________________
| todo-basic web app                       |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | PhaseLock Engine                  |  |
|       _________           _________      |
|   |  |      [1]|         |      [3]|  |  |
|      |  store  |-------->| queries |     |
|   |  |_________|         |_________|  |  |
|         ^            _ _ _ _ _|_ _ _ _   |
|   |   __|_______    |         |          |
|      |       [2]|           __v___       |
|   |  | reducer  |   |      |   [4]|      |
|      |__________|          |  UI  |      |
|   |_ _ _^_ _ _ _ _ _|      |______|      |
|         |                     |          |
|   ______|_____________________v_______   |
|  |                                    |  |
|  |            websocket [5]           |  |
|  |____________________________________|  |
|_________^_____________________|__________|
          |                     |
          |                     |
    ______|_____________________v_______
   |                                    |
   |             server [6]             |
   |____________________________________|
          ^                     |
          |                     |
    ______|_____________________v_______
   |                                    |
   |            KurrentDB               |
   |____________________________________|
```

- [1] model/model.tsp defines event types and store layout using TypeSpec
- [2] model/reducers.ts defines reducer functions that build state from events
- [3] ui/src/Window.tsx defines queries in-line with the UI components
- [4] ui/src/useLocalQuery.ts defines the react hook for queries
- [5] ui/src/usePhaseLock.ts connects a websocket to a PhaseLock Engine
- [6] server/main.ts relays events and commands between KurrentDB and the client

## Run the example

Steps to run the example:

- ensure `docker` is available (to run KurrentDB locally)
- install dependencies: `pnpm i`
- generate code: `pnpm gen`
- run the demo in dev mode: `pnpm dev`
- visit `http://localhost:3000` in your browser
