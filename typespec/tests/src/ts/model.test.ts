/**
 * What the TypeScript emitter generates from the slice vocabulary.  The emitter is rewritten
 * against the new IR in its own step; until then these are the behaviors it owes, recorded as
 * todos so none is forgotten.
 */

import { describe, it } from 'vitest';

describe('reducer contexts', () => {
  it.todo('generates one reducer context per slice, over its local key templates');
  it.todo("gives reducer accessors only the local template's own parameters (get.patron())");
  it.todo('generates get, set, del, and update accessors, get answering undefined when absent');
  it.todo('generates a handler table per slice: one reducer handler per event type');
  it.todo("dispatches a run of events on each event's discriminant in the generated wrapper");
  it.todo('parses the stream name into typed params and hands them to the handlers');
});

describe('global contexts', () => {
  it.todo('generates a read-only global context per engine, over its slices');
  it.todo('generates a read-only global context per database, over all of its slices');
  it.todo("gives global accessors the family's parameters, then the local key's");
});

describe('precommit', () => {
  it.todo('generates a precommit interface with one handler per @command model');
  it.todo('keys the handlers by the camelCased model name');
  it.todo('types each handler as (txn, auth, cmd), with cmd the command as precommit sees it');
  it.todo("types each handler's return from its @command output, each event stream-labelled");
  it.todo("types a singleton slice's stream label as its literal family name");
  it.todo("types an event folded by several slices with any of those slices' streams");
  it.todo('types a Death output as { stream, death: true }');
  it.todo('flattens tuple and array outputs into the list the wrapper returns');
  it.todo('makes a missing handler and a misspelled extra handler compile errors');
  it.todo('rejects a handler that returns without an authorization decision (fail closed)');
});

describe('intake types', () => {
  it.todo('types a command on the client with wire types (NewPassword as string)');
  it.todo('types the same command in precommit with results (a PasswordHash brand)');
  it.todo('makes a plain string unassignable to PasswordHash and the other result brands');
  it.todo("generates the bundle's hashedFields from the NewPassword fields");
});

describe('sending commands', () => {
  it.todo('accepts @online commands only through sendNow and the rest only through sendCommands');
  it.todo("gives the database's own commands a direct-send helper, for use before sign-in");
});

describe('schema and bundle', () => {
  it.todo("generates storeTypes from every slice's key templates");
  it.todo("generates eventTypes from each slice's family to its events union");
  it.todo('generates the engine subclass taking its reducers and forecaster, deriving its wants');
  it.todo('types the bootstrap slot: emit(stream, event) typed like precommit outputs');
});
