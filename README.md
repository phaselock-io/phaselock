# PhaseLock

No more polling for new data.  No more writing REST APIs.

Define your data types and how to process them once, and reuse that in your web
app, your mobile apps, and your backend workers.

## How does PhaseLock work?

     ______________________________
    |          Frontend            |
    |  _________   _______   ____  |
    | |         | |       | |    | |
    | | Reducer | | State | | UI | |
    | |_________| |_______| |____| |
    |___^____________________|_____|
        |                    |
        | Events             | Commands
        | are                | are
        | read               | written
     ___|____________________v_____
    |                              |
    |   Backend holds event log    |
    |______________________________|

PhaseLock assumes you save all your **events** (like, "user X
did Y") in a log.

Then you write a **reducer** function that reads events and
builds state in a key-value store.

Then the sync engine behavior is obvious:

- An offline-capable client streams events since it last connected.
- The reducer updates local state, triggering UI updates.
- User actions (called **commands** until they're accepted as
  events) are queued in an outbox until they can be sent.
- Optimistic updates are calculated using the reducer you already wrote.

PhaseLock is tooling around this simple architecture to unlock:

- Live queries against current state
- Optimistic updates without modifying reducers or UI
- Offline-capable clients that maintain state locally
- Thin clients that rely on server-side state
- Hybrid clients that read server-side state while hydrating local state
- Backend workers that watch the event log to trigger side-effects

Next step: check out one of our [examples][examples].

## What database do I use for PhaseLock?

Today's examples run against KurrentDB, which works well for PhaseLock apps.

You could also make Postgres work, though we don't have examples of that yet.

## How do I start using PhaseLock?

PhaseLock is still in alpha.  Tests are sparse, docs are missing.

Your coding agent can help until our docs are ready.  Try:

- For Claude (as a plugin):

  ```
  /plugin marketplace add phaselock-io/phaselock
  /plugin install phaselock@phaselock
  ```

- For any agent (as a skill):
  ```
  npx skills add phaselock-io/phaselock
  ```

Then ask your agent: "How do I use PhaseLock to build \<describe your app\>?"

Also check out our [examples][examples], which demonstrate many of the core
capabilities.

Finally, skim through [skeleton.ts][skeleton-ts], the backbone of all of PhaseLock.

Open issues when you find them, and [send us a 'hello' email](mailto:hello@phaselock.io)!

## We're building a cloud!

Deploy a PhaseLock app with a single command.  [Sign up][mailing-list] for
development updates and to be the first to try it out.

[examples]: https://github.com/phaselock-io/phaselock/tree/master/examples
[mailing-list]: https://buttondown.com/phaselock
[skeleton-ts]: https://github.com/phaselock-io/phaselock/blob/master/typespec/ts/assets/skeleton.ts
