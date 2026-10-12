/* The plugin contract, as a database holds its plugins.  A database's generated code declares the
   same shapes in its skeleton, and TypeScript compares them structurally, so a plugin package
   needs nothing from any app's generated code. */

/** one output of a database: an event on a stream, or a stream's death */
export type Output = { stream: string; event: unknown } | { stream: string; death: true };

/** the raw transaction a database binds its plugins to, whose `emit` adds outputs to the atom
    being built */
export interface RawTxn {
  emit?(outputs: Output[]): void;
}

/** A plugin as one database holds it: the name it is installed under, its request API, its
    config if it is a built-in, bind, which points it at the database's raw transaction, and run,
    which handles one of the plugin's own commands and answers its outputs. */
export interface Plugin<Api extends object = object> {
  readonly name: string;
  readonly api: Api;
  readonly config?: unknown;
  bind(txn: RawTxn): void;
  run?(cmd: unknown): Output[];
}

/** What a plugin's install answers: its kind, which prefixes its type identities, and create,
    which makes the plugin under the name a database installs it by, over the database's context,
    the txn of the app's hooks. */
export interface PluginInstall<Api extends object = object> {
  readonly kind: string;
  create(name: string, ctx: unknown): Plugin<Api>;
}

/** the types a database hands a plugin's hooks: the txn they read through and the outputs they
    return */
export type DbTypes = { txn: unknown; output: unknown };

/** What ties an install to one database's types.  DB appears bare, so an install infers it from
    the plugins slot it lands in. */
export type DbMarker<DB extends DbTypes> = { readonly db: (db: DB) => DB };
