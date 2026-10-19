# `library` data model

This `model/` directory contains the declared data model for the simulated
library.

`model.tsp`: overall data model declarations.

- Command and event types.
- Which events are produced by each command.
- Store types and layouts.
- Slice definitions.
- Which slices each sync engine will consume.
- Named query declarations.

`model.gen.ts`: generated output from `model.tsp`.

- Not committed into the repository.
- Contains TypeScript type definitions.
- Defines the sync engine classes: `AdminEngine` and `UserEngine`.

`reducers.ts`: defines how each event is processed to update the Store.

`outcomes.ts`: core business logic used by both `forecasters` and `precommit`.

`ui.ts`: the stub of exports and functions that ship with the client.

- `forecasters` defines how commands are expected to produce events.

`db.ts`: the stub of exports and functions that deploy into the database.

- `precommit` defines how commands are accepted and what events they emit.
- `lookup` returns authentication information for a user.
- `maySee` defines which slices each signed-in user is allowed to see.
- Configures the `cron` plugin for the library's daily sheet and room resets.

`queries.ts`: definitions of named queries.

- Functions implementing each named query from `model.tsp`.

`rooms.ts`: additional logic specific to the hosted version of this demo.

- The whole demo runs in each "room", and each visitor gets their own room.
