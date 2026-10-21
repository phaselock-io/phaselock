# `library` data model

This `model/` directory contains the declared data model for the simulated
library.

`model.tsp`: overall data model declarations.

- Store types and layouts.
- Slice definitions.
- Which slices each sync engine will consume.
- Mutation types.
- Named query declarations.

`model.gen.ts`: generated output from `model.tsp`.

- Not committed into the repository.
- Contains TypeScript type definitions.
- Defines the sync engine classes: `AdminEngine` and `UserEngine`.

`predictors.ts`: core business logic.
- Defines how each mutation type is handled to update state.
- Each mutation's predictor is just that handler.
- Each mutation's decider checks authorization, then calls the handler.

`ui.ts`: the stub of exports and functions that ship with the client.

`db.ts`: the stub of exports and functions that deploy into the database.

- `deciders` defines if mutations are accepted and how they are handled.
- `lookup` returns authentication information for a user.
- `grant` defines which slices each signed-in user is allowed to see.
- Configures the `cron` plugin for the library's daily sheet and room resets.

`queries.ts`: definitions of named queries.

- Functions implementing each named query from `model.tsp`.

`rooms.ts`: additional logic specific to the hosted version of this demo.

- The whole demo runs in each "room", and each visitor gets their own room.
