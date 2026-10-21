/* The plugin contract, as a database holds its plugins.  A database's generated code declares the
   same shapes in its skeleton, there with the transaction's own type, and TypeScript compares
   them structurally, so a plugin package needs nothing from any app's generated code. */

/** The transaction a database binds a plugin to, which the plugin hands to its own contexts
    without reading it itself. */
export type Txn = unknown;

/** A plugin as one database holds it: the name it is installed under, its request API, which app
    code calls as `txn.{name}`, bind, which points the plugin's own contexts at the transaction
    the database binds its write context to, and, for a plugin with mutations of its own, run,
    which carries one of them out, a cron tick or a worker's result, by writing through that
    transaction.  A request is a write to the plugin's own slice, committed with the rest of the
    transaction's writes, which the host acts on after the commit.  A built-in's config is what
    the host reads of it, by its install's kind. */
export interface Plugin<Api extends object = object> {
  readonly name: string;
  readonly api: Api;
  readonly config?: unknown;
  bind(txn: Txn): void;
  run?(mutation: unknown): void;
}

/** What a plugin's install answers and a plugin set lists: the plugin's kind, which prefixes its
    type identities, and create, which makes the plugin under the name a database installs it by.
    ctx is the database's write context, the txn of the app's hooks, which the database binds to
    its transaction along with every plugin. */
export interface PluginInstall<Api extends object = object> {
  readonly kind: string;
  create(name: string, ctx: unknown): Plugin<Api>;
}

/** the types a database hands a plugin's hooks: the txn they read and write through */
export type DbTypes = { txn: unknown };

/** What ties an installed plugin to one database's types.  DB appears bare, so a plugin's install
    infers it from the slot it lands in, and an install for one database fits no other's. */
export type DbMarker<DB extends DbTypes> = { readonly db: (db: DB) => DB };
