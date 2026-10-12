import type { DbMarker, DbTypes, Output, Plugin, PluginInstall, RawTxn } from './plugin.js';

/** One tick of a cron entry: the entry's name; the slot it was scheduled for, which names the
    occurrence (which day's sheet); and the server time of its atom, which bounds what is due. */
export type Tick = { name: string; slot: Date; now: Date };

/** A cron entry: its spec, a robfig/cron standard spec of five fields or a descriptor, in UTC
    unless it starts with `CRON_TZ=`; and its hook, which runs over the database's txn at each
    tick and answers what the tick adds to the log.  A hook must not throw: a throw is a bug,
    which drops the tick's atom. */
export type CronEntry<DB extends DbTypes> = {
  spec: string;
  hook(txn: DB['txn'], tick: Tick): DB['output'] | DB['output'][];
};

/** the cron plugin as a plugin set names it; it makes no requests */
export type CronPlugin = PluginInstall<{}>;

/** what the database reads of a cron install when it opens: every entry's name and spec */
export type CronConfig = { entries: { name: string; spec: string }[] };

// the command the database hands cron's run: one tick of one entry
type TickCommand = { entry: string; slot: Date; now: Date };

// an entry's name, at most 64 bytes, part of the session key that holds its mark
const ENTRY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The built-in plugin that runs hooks on a schedule, so a database runs its own daily sheets and
    sweeps.  Its entries are named, and a name is durable: the database keeps each entry's last
    slot under it, so renaming an entry starts it afresh. */
export const Cron = {
  install<DB extends DbTypes>(entries: Record<string, CronEntry<DB>>): CronPlugin & DbMarker<DB> {
    for (const name of Object.keys(entries)) {
      if (!ENTRY_NAME_RE.test(name)) {
        throw new Error(`cron entry name ${JSON.stringify(name)} is not 1 to 64 of [A-Za-z0-9_-]`);
      }
    }
    const config: CronConfig = {
      entries: Object.entries(entries).map(([name, e]) => ({ name, spec: e.spec })),
    };
    return {
      kind: 'cron',
      db: (db) => db,
      create(name: string, ctx: unknown): Plugin<{}> {
        let raw: RawTxn | undefined;

        // each entry's hook, called over the database's context, its outputs emitted
        const hooks = new Map<string, (tick: Tick) => void>();
        for (const [entry, e] of Object.entries(entries)) {
          hooks.set(entry, (tick) => {
            const out = e.hook(ctx as DB['txn'], tick);
            raw!.emit!([out].flat() as Output[]);
          });
        }

        return {
          name,
          api: {},
          config,
          bind(txn) {
            raw = txn;
          },
          run(cmd) {
            const { entry, slot, now } = cmd as TickCommand;
            const hook = hooks.get(entry);
            if (hook === undefined) throw new Error(`cron install ${name} has no entry ${entry}`);
            hook({ name: entry, slot, now });
            return [];
          },
        };
      },
    };
  },
};
