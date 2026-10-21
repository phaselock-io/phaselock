import type { DbMarker, DbTypes, Plugin, PluginInstall } from './plugin.js';

/** One tick of a cron entry: the entry's name; the slot it was scheduled for, which names the
    occurrence (which day's sheet); and the server time of the tick's mutation, which bounds what
    is due. */
export type Tick = { name: string; slot: Date; now: Date };

/** A cron entry: its spec, a robfig/cron standard spec of five fields or a descriptor, in UTC
    unless it starts with `CRON_TZ=`; and its hook, which carries out each tick by writing through
    the database's txn, as a decider does.  A hook must not throw: a throw is a bug, which
    discards the tick's writes. */
export type CronEntry<DB extends DbTypes> = {
  spec: string;
  hook(txn: DB['txn'], tick: Tick): void;
};

/** the cron plugin as a plugin set names it; it makes no requests */
export type CronPlugin = PluginInstall<{}>;

/** what the database reads of a cron install when it opens: every entry's name and spec */
export type CronConfig = { entries: { name: string; spec: string }[] };

// the mutation the database hands cron's run: one tick of one entry
type TickMutation = { entry: string; slot: Date; now: Date };

// an entry's name, at most 64 bytes, part of the series key that holds its mark
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
        const byName = new Map(Object.entries(entries));
        return {
          name,
          api: {},
          config,
          bind() {}, // the hooks run over ctx, which the database binds itself
          run(mutation) {
            const { entry, slot, now } = mutation as TickMutation;
            const e = byName.get(entry);
            if (e === undefined) throw new Error(`cron install ${name} has no entry ${entry}`);
            e.hook(ctx as DB['txn'], { name: entry, slot, now });
          },
        };
      },
    };
  },
};
