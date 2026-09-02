# PhaseLock examples

[**todo-basic**](./todo-basic) shows the absolute basics of using PhaseLock:
- defining data types and reducers
- streaming events from KurrentDB to a client-side PhaseLock Engine
- connecting live query results to your UI

[**todo-thin**](./todo-thin) builds on `todo-basic` by adding Query definitions
to the data model.  This unlocks the ability to power the _exact same UI_ but
with the PhaseLock Engine now running in the server.

[**library**](./library) models a library (as in, "a place to check out books"),
illustrating how the PhaseLock architecture solves complex collaboration
problems with ease.  Additionally, this example shows:
- offline-capable UIs with optimistic updates
- a backend worker that uses PhaseLock for resolving conflicts
- a relay that sanitizes events for the client
- a relay that uses PhaseLock to semantically validate commands
- cross-language packaging of a PhaseLock data model into Go and Python

<!-- TODO: a chart of features and which examples illustrate which features -->
