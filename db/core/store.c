/* SQLite storage: the KV store, the log, the command dedup table, and the
   known-streams table live in one database file. */

#include "internal.h"

struct store {
    sqlite3 *db;
    char err[512];
    sqlite3_stmt *get, *set, *del, *scan, *scan_all, *del_prefix, *append, *read_log,
        *seek_ge, *seek_gt, *seek_le, *seek_lt, *seek_first, *seek_last,
        *max_pos, *cmd_pos, *cmd_ins, *stream_live, *stream_birth, *stream_death, *stream_seq,
        *live_streams, *live_streams_all, *live_stream, *kv_len, *stream_state, *stream_state_zero, *stream_stats,
        *read_stream_asc, *read_stream_desc, *read_prefix_asc, *read_prefix_desc;
    // the kv cursor's statement, positioned at its key, or NULL past the end of its walk
    sqlite3_stmt *cursor;
};

static const char *SCHEMA =
    "PRAGMA journal_mode=WAL;"
    "PRAGMA synchronous=FULL;"
    "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;"
    "CREATE TABLE IF NOT EXISTS log (position INTEGER PRIMARY KEY, stream TEXT NOT NULL,"
    "  seq INTEGER NOT NULL, commandid TEXT NOT NULL, servertime INTEGER NOT NULL,"
    "  data BLOB NOT NULL);"
    "CREATE INDEX IF NOT EXISTS log_stream ON log(stream, position);"
    "CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, position INTEGER NOT NULL)"
    "  WITHOUT ROWID;"
    "CREATE TABLE IF NOT EXISTS streams (name TEXT PRIMARY KEY, birth INTEGER NOT NULL,"
    "  death INTEGER, seq INTEGER NOT NULL,"
    "  event_bytes INTEGER NOT NULL DEFAULT 0, state_bytes INTEGER NOT NULL DEFAULT 0)"
    "  WITHOUT ROWID;";

static int fail(store *s, const char *what) {
    snprintf(s->err, sizeof s->err, "%s: %s", what, sqlite3_errmsg(s->db));
    return -1;
}

static int prep(store *s, sqlite3_stmt **out, const char *sql) {
    if (sqlite3_prepare_v2(s->db, sql, -1, out, NULL) != SQLITE_OK) return fail(s, sql);
    return 0;
}

int store_open(const char *path, bool writer, store **out, char *err, size_t errlen) {
    store *s = xmalloc(sizeof *s);
    memset(s, 0, sizeof *s);
    int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
    if (sqlite3_open_v2(path, &s->db, flags, NULL) != SQLITE_OK) {
        snprintf(err, errlen, "open %s: %s", path, sqlite3_errmsg(s->db));
        store_close(s);
        return -1;
    }
    sqlite3_busy_timeout(s->db, 5000);
    if (writer && store_exec(s, SCHEMA) != 0) {
        snprintf(err, errlen, "%s", s->err);
        store_close(s);
        return -1;
    }
    /* the upper bound of a prefix range is bound by the caller as ?2 */
    int rc = prep(s, &s->get, "SELECT value FROM kv WHERE key = ?1") ||
             prep(s, &s->set, "INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)") ||
             prep(s, &s->del, "DELETE FROM kv WHERE key = ?1") ||
             prep(s, &s->scan,
                  "SELECT key, value FROM kv WHERE key >= ?1 AND key < ?2 ORDER BY key") ||
             prep(s, &s->scan_all, "SELECT key, value FROM kv ORDER BY key") ||
             prep(s, &s->del_prefix, "DELETE FROM kv WHERE key >= ?1 AND key < ?2") ||
             prep(s, &s->seek_ge, "SELECT key, value FROM kv WHERE key >= ?1 ORDER BY key") ||
             prep(s, &s->seek_gt, "SELECT key, value FROM kv WHERE key > ?1 ORDER BY key") ||
             prep(s, &s->seek_le, "SELECT key, value FROM kv WHERE key <= ?1 ORDER BY key DESC") ||
             prep(s, &s->seek_lt, "SELECT key, value FROM kv WHERE key < ?1 ORDER BY key DESC") ||
             prep(s, &s->seek_first, "SELECT key, value FROM kv ORDER BY key") ||
             prep(s, &s->seek_last, "SELECT key, value FROM kv ORDER BY key DESC") ||
             prep(s, &s->append,
                  "INSERT INTO log (position, stream, seq, commandid, servertime, data)"
                  " VALUES (?1, ?2, ?3, ?4, ?5, ?6)") ||
             prep(s, &s->read_log,
                  "SELECT position, stream, seq, commandid, servertime, data FROM log"
                  " WHERE position >= ?1 AND position <= ?2 ORDER BY position") ||
             prep(s, &s->read_stream_asc,
                  "SELECT position, stream, seq, commandid, servertime, data FROM log"
                  " WHERE stream = ?1 AND position > ?2 AND position < ?3"
                  " ORDER BY position LIMIT ?4") ||
             prep(s, &s->read_stream_desc,
                  "SELECT position, stream, seq, commandid, servertime, data FROM log"
                  " WHERE stream = ?1 AND position > ?2 AND position < ?3"
                  " ORDER BY position DESC LIMIT ?4") ||
             /* rowid scan filtered by prefix; the (stream, position) index would
                range the prefix and then sort every event in it */
             prep(s, &s->read_prefix_asc,
                  "SELECT position, stream, seq, commandid, servertime, data FROM log"
                  " NOT INDEXED WHERE position > ?1 AND position < ?2"
                  " AND stream >= ?3 AND stream < ?4 ORDER BY position LIMIT ?5") ||
             prep(s, &s->read_prefix_desc,
                  "SELECT position, stream, seq, commandid, servertime, data FROM log"
                  " NOT INDEXED WHERE position > ?1 AND position < ?2"
                  " AND stream >= ?3 AND stream < ?4 ORDER BY position DESC LIMIT ?5") ||
             prep(s, &s->max_pos, "SELECT COALESCE(MAX(position), 0) FROM log") ||
             prep(s, &s->cmd_pos, "SELECT position FROM commands WHERE id = ?1") ||
             prep(s, &s->cmd_ins, "INSERT INTO commands (id, position) VALUES (?1, ?2)") ||
             prep(s, &s->stream_live, "SELECT death IS NULL FROM streams WHERE name = ?1") ||
             prep(s, &s->stream_birth,
                  "INSERT INTO streams (name, birth, seq) VALUES (?1, ?2, 0)"
                  " ON CONFLICT (name) DO UPDATE SET birth = excluded.birth, death = NULL") ||
             prep(s, &s->stream_death,
                  "UPDATE streams SET death = ?2 WHERE name = ?1 AND death IS NULL") ||
             prep(s, &s->stream_seq,
                  "UPDATE streams SET seq = seq + 1, event_bytes = event_bytes + ?2"
                  " WHERE name = ?1 RETURNING seq") ||
             prep(s, &s->kv_len, "SELECT length(value) FROM kv WHERE key = ?1") ||
             prep(s, &s->stream_state,
                  "UPDATE streams SET state_bytes = state_bytes + ?2 WHERE name = ?1") ||
             prep(s, &s->stream_state_zero, "UPDATE streams SET state_bytes = 0 WHERE name = ?1") ||
             prep(s, &s->stream_stats,
                  "SELECT seq, event_bytes, state_bytes FROM streams WHERE name = ?1") ||
             prep(s, &s->live_streams,
                  "SELECT name, seq FROM streams WHERE name >= ?1 AND name < ?2"
                  " AND death IS NULL ORDER BY name") ||
             prep(s, &s->live_streams_all,
                  "SELECT name, seq FROM streams WHERE death IS NULL ORDER BY name") ||
             prep(s, &s->live_stream, "SELECT seq FROM streams WHERE name = ?1 AND death IS NULL");
    if (rc) {
        snprintf(err, errlen, "%s", s->err);
        store_close(s);
        return -1;
    }
    *out = s;
    return 0;
}

void store_close(store *s) {
    if (!s) return;
    sqlite3_stmt *stmts[] = {s->get, s->set, s->del, s->scan, s->scan_all, s->del_prefix,
                             s->seek_ge, s->seek_gt, s->seek_le, s->seek_lt, s->seek_first,
                             s->seek_last,
                             s->append, s->read_log, s->max_pos, s->cmd_pos, s->cmd_ins,
                             s->stream_live, s->stream_birth, s->stream_death,
                             s->stream_seq, s->live_streams, s->live_streams_all, s->live_stream,
                             s->kv_len,
                             s->stream_state, s->stream_state_zero, s->stream_stats,
                             s->read_stream_asc, s->read_stream_desc, s->read_prefix_asc,
                             s->read_prefix_desc};
    for (size_t i = 0; i < sizeof stmts / sizeof *stmts; i++) sqlite3_finalize(stmts[i]);
    sqlite3_close(s->db);
    free(s);
}

const char *store_err(store *s) { return s->err; }

int store_exec(store *s, const char *sql) {
    char *msg = NULL;
    if (sqlite3_exec(s->db, sql, NULL, NULL, &msg) != SQLITE_OK) {
        snprintf(s->err, sizeof s->err, "%s: %s", sql, msg ? msg : "?");
        sqlite3_free(msg);
        return -1;
    }
    return 0;
}

/* the exclusive upper bound of the key range sharing prefix; false if the
   prefix is empty (unbounded) */
static bool prefix_bound(const char *prefix, char *bound, size_t cap) {
    size_t n = strlen(prefix);
    if (n == 0 || n + 1 > cap) return false;
    memcpy(bound, prefix, n + 1);
    while (n > 0) {
        if ((unsigned char)bound[n - 1] != 0xFF) {
            bound[n - 1]++;
            return true;
        }
        bound[--n] = 0;
    }
    return false;
}

static int step_done(store *s, sqlite3_stmt *st, const char *what) {
    int rc = sqlite3_step(st);
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return rc == SQLITE_DONE ? 0 : fail(s, what);
}

int store_get(store *s, const char *key, uint8_t **val, size_t *len) {
    sqlite3_bind_text(s->get, 1, key, -1, SQLITE_STATIC);
    int rc = sqlite3_step(s->get);
    int out;
    if (rc == SQLITE_ROW) {
        *len = sqlite3_column_bytes(s->get, 0);
        *val = xmalloc(*len);
        memcpy(*val, sqlite3_column_blob(s->get, 0), *len);
        out = 1;
    } else if (rc == SQLITE_DONE) {
        out = 0;
    } else {
        out = fail(s, "get");
    }
    sqlite3_reset(s->get);
    sqlite3_clear_bindings(s->get);
    return out;
}

/* the stored size of key, counting key and value bytes; -1 if absent */
static int64_t stored_size(store *s, const char *key) {
    sqlite3_bind_text(s->kv_len, 1, key, -1, SQLITE_STATIC);
    int64_t out = -1;
    if (sqlite3_step(s->kv_len) == SQLITE_ROW)
        out = sqlite3_column_int64(s->kv_len, 0) + (int64_t)strlen(key);
    sqlite3_reset(s->kv_len);
    sqlite3_clear_bindings(s->kv_len);
    return out;
}

/* charge delta bytes of state to the stream owning key, the text before its first '!' */
static int charge_state(store *s, const char *key, int64_t delta) {
    if (delta == 0) return 0;
    const char *bang = strchr(key, '!');
    if (!bang) return 0;
    sqlite3_bind_text(s->stream_state, 1, key, (int)(bang - key), SQLITE_STATIC);
    sqlite3_bind_int64(s->stream_state, 2, delta);
    return step_done(s, s->stream_state, "stream_state");
}

int store_set(store *s, const char *key, const uint8_t *val, size_t len) {
    int64_t before = stored_size(s, key);
    sqlite3_bind_text(s->set, 1, key, -1, SQLITE_STATIC);
    sqlite3_bind_blob(s->set, 2, val, (int)len, SQLITE_STATIC);
    if (step_done(s, s->set, "set")) return -1;
    int64_t after = (int64_t)len + (int64_t)strlen(key);
    return charge_state(s, key, after - (before < 0 ? 0 : before));
}

int store_del(store *s, const char *key) {
    int64_t before = stored_size(s, key);
    sqlite3_bind_text(s->del, 1, key, -1, SQLITE_STATIC);
    if (step_done(s, s->del, "del")) return -1;
    return before < 0 ? 0 : charge_state(s, key, -before);
}

int store_scan(store *s, const char *prefix, store_kv_fn fn, void *arg) {
    char bound[1024];
    sqlite3_stmt *st;
    if (prefix_bound(prefix, bound, sizeof bound)) {
        st = s->scan;
        sqlite3_bind_text(st, 1, prefix, -1, SQLITE_STATIC);
        sqlite3_bind_text(st, 2, bound, -1, SQLITE_TRANSIENT);
    } else {
        st = s->scan_all;
    }
    int rc, out = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        const char *key = (const char *)sqlite3_column_text(st, 0);
        const uint8_t *val = sqlite3_column_blob(st, 1);
        size_t len = sqlite3_column_bytes(st, 1);
        if (fn(arg, key, val, len) != 0) {
            out = -1;
            break;
        }
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) out = fail(s, "scan");
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return out;
}

/* move the cursor onto the row its statement steps to; 1 at a key, 0 past the end, -1 on error */
static int cursor_land(store *s) {
    int rc = sqlite3_step(s->cursor);
    if (rc == SQLITE_ROW) return 1;
    sqlite3_stmt *st = s->cursor;
    s->cursor = NULL;
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return rc == SQLITE_DONE ? 0 : fail(s, "cursor");
}

int store_cursor_seek(store *s, bool reverse, const char *target, size_t n, bool strict) {
    store_cursor_end(s);

    // a statement per direction and bound, re-bound per seek
    if (!target) {
        s->cursor = reverse ? s->seek_last : s->seek_first;
    } else {
        if (reverse) {
            s->cursor = strict ? s->seek_lt : s->seek_le;
        } else {
            s->cursor = strict ? s->seek_gt : s->seek_ge;
        }
        sqlite3_bind_text(s->cursor, 1, target, (int)n, SQLITE_TRANSIENT);
    }
    return cursor_land(s);
}

int store_cursor_step(store *s) {
    if (!s->cursor) return 0;
    return cursor_land(s);
}

const char *store_cursor_key(store *s, size_t *n) {
    const char *key = (const char *)sqlite3_column_text(s->cursor, 0);
    *n = (size_t)sqlite3_column_bytes(s->cursor, 0);
    return key;
}

const uint8_t *store_cursor_value(store *s, size_t *n) {
    const uint8_t *val = sqlite3_column_blob(s->cursor, 1);
    *n = (size_t)sqlite3_column_bytes(s->cursor, 1);
    return val;
}

void store_cursor_end(store *s) {
    if (!s->cursor) return;
    sqlite3_reset(s->cursor);
    sqlite3_clear_bindings(s->cursor);
    s->cursor = NULL;
}

int store_del_prefix(store *s, const char *prefix) {
    char bound[1024];
    if (!prefix_bound(prefix, bound, sizeof bound)) return store_exec(s, "DELETE FROM kv");
    sqlite3_bind_text(s->del_prefix, 1, prefix, -1, SQLITE_STATIC);
    sqlite3_bind_text(s->del_prefix, 2, bound, -1, SQLITE_TRANSIENT);
    if (step_done(s, s->del_prefix, "del_prefix")) return -1;
    size_t n = strlen(prefix);
    if (n > 1 && prefix[n - 1] == '!') {
        sqlite3_bind_text(s->stream_state_zero, 1, prefix, (int)(n - 1), SQLITE_STATIC);
        return step_done(s, s->stream_state_zero, "stream_state_zero");
    }
    return 0;
}

int store_append(store *s, uint64_t position, const char *stream, uint64_t seq,
                 const char *commandid, int64_t servertime, const uint8_t *data, size_t len) {
    sqlite3_bind_int64(s->append, 1, (sqlite3_int64)position);
    sqlite3_bind_text(s->append, 2, stream, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->append, 3, (sqlite3_int64)seq);
    sqlite3_bind_text(s->append, 4, commandid, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->append, 5, servertime);
    sqlite3_bind_blob(s->append, 6, data, (int)len, SQLITE_STATIC);
    return step_done(s, s->append, "append");
}

int store_read_log(store *s, uint64_t from, uint64_t to, store_log_fn fn, void *arg) {
    sqlite3_stmt *st = s->read_log;
    sqlite3_bind_int64(st, 1, (sqlite3_int64)from);
    sqlite3_bind_int64(st, 2, (sqlite3_int64)to);
    int rc, out = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (fn(arg, (uint64_t)sqlite3_column_int64(st, 0),
               (const char *)sqlite3_column_text(st, 1), (uint64_t)sqlite3_column_int64(st, 2),
               (const char *)sqlite3_column_text(st, 3), sqlite3_column_int64(st, 4),
               sqlite3_column_blob(st, 5), sqlite3_column_bytes(st, 5)) != 0) {
            out = -1;
            break;
        }
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) out = fail(s, "read_log");
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return out;
}

int store_read_stream(store *s, const char *stream, uint64_t from, uint64_t to, bool reverse,
                      size_t limit, store_log_fn fn, void *arg) {
    sqlite3_stmt *st = reverse ? s->read_stream_desc : s->read_stream_asc;
    sqlite3_bind_text(st, 1, stream, -1, SQLITE_STATIC);
    sqlite3_bind_int64(st, 2, (sqlite3_int64)from);
    sqlite3_bind_int64(st, 3, (sqlite3_int64)to);
    sqlite3_bind_int64(st, 4, (sqlite3_int64)limit);
    int rc, out = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (fn(arg, (uint64_t)sqlite3_column_int64(st, 0),
               (const char *)sqlite3_column_text(st, 1), (uint64_t)sqlite3_column_int64(st, 2),
               (const char *)sqlite3_column_text(st, 3), sqlite3_column_int64(st, 4),
               sqlite3_column_blob(st, 5), sqlite3_column_bytes(st, 5)) != 0) {
            out = -1;
            break;
        }
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) out = fail(s, "read_stream");
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return out;
}

int store_read_prefix(store *s, const char *prefix, uint64_t from, uint64_t to, bool reverse,
                      size_t limit, store_log_fn fn, void *arg) {
    sqlite3_stmt *st = reverse ? s->read_prefix_desc : s->read_prefix_asc;
    char bound[1024];
    /* stream names are ASCII, so DEL bounds the empty prefix */
    if (!prefix_bound(prefix, bound, sizeof bound)) strcpy(bound, "\x7f");
    sqlite3_bind_int64(st, 1, (sqlite3_int64)from);
    sqlite3_bind_int64(st, 2, (sqlite3_int64)to);
    sqlite3_bind_text(st, 3, prefix, -1, SQLITE_STATIC);
    sqlite3_bind_text(st, 4, bound, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(st, 5, (sqlite3_int64)limit);
    int rc, out = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (fn(arg, (uint64_t)sqlite3_column_int64(st, 0),
               (const char *)sqlite3_column_text(st, 1), (uint64_t)sqlite3_column_int64(st, 2),
               (const char *)sqlite3_column_text(st, 3), sqlite3_column_int64(st, 4),
               sqlite3_column_blob(st, 5), sqlite3_column_bytes(st, 5)) != 0) {
            out = -1;
            break;
        }
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) out = fail(s, "read_prefix");
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return out;
}

int store_max_position(store *s, uint64_t *out) {
    int rc = sqlite3_step(s->max_pos);
    if (rc != SQLITE_ROW) {
        sqlite3_reset(s->max_pos);
        return fail(s, "max_position");
    }
    *out = (uint64_t)sqlite3_column_int64(s->max_pos, 0);
    sqlite3_reset(s->max_pos);
    return 0;
}

int store_command_position(store *s, const char *id, uint64_t *pos) {
    sqlite3_bind_text(s->cmd_pos, 1, id, -1, SQLITE_STATIC);
    int rc = sqlite3_step(s->cmd_pos);
    int out;
    if (rc == SQLITE_ROW) {
        *pos = (uint64_t)sqlite3_column_int64(s->cmd_pos, 0);
        out = 1;
    } else if (rc == SQLITE_DONE) {
        out = 0;
    } else {
        out = fail(s, "command_position");
    }
    sqlite3_reset(s->cmd_pos);
    sqlite3_clear_bindings(s->cmd_pos);
    return out;
}

int store_command_insert(store *s, const char *id, uint64_t pos) {
    sqlite3_bind_text(s->cmd_ins, 1, id, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->cmd_ins, 2, (sqlite3_int64)pos);
    return step_done(s, s->cmd_ins, "command_insert");
}

int store_stream_live(store *s, const char *name) {
    sqlite3_bind_text(s->stream_live, 1, name, -1, SQLITE_STATIC);
    int rc = sqlite3_step(s->stream_live);
    int out;
    if (rc == SQLITE_ROW) {
        out = sqlite3_column_int(s->stream_live, 0) ? 1 : 0;
    } else if (rc == SQLITE_DONE) {
        out = 0;
    } else {
        out = fail(s, "stream_live");
    }
    sqlite3_reset(s->stream_live);
    sqlite3_clear_bindings(s->stream_live);
    return out;
}

int store_stream_birth(store *s, const char *name, uint64_t pos) {
    sqlite3_bind_text(s->stream_birth, 1, name, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->stream_birth, 2, (sqlite3_int64)pos);
    return step_done(s, s->stream_birth, "stream_birth");
}

int store_stream_death(store *s, const char *name, uint64_t pos) {
    sqlite3_bind_text(s->stream_death, 1, name, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->stream_death, 2, (sqlite3_int64)pos);
    return step_done(s, s->stream_death, "stream_death");
}

int store_stream_next_seq(store *s, const char *name, size_t bytes, uint64_t *seq) {
    sqlite3_bind_text(s->stream_seq, 1, name, -1, SQLITE_STATIC);
    sqlite3_bind_int64(s->stream_seq, 2, (sqlite3_int64)bytes);
    int rc = sqlite3_step(s->stream_seq);
    int out;
    if (rc == SQLITE_ROW) {
        *seq = (uint64_t)sqlite3_column_int64(s->stream_seq, 0);
        out = 0;
    } else {
        out = fail(s, "stream_next_seq");
    }
    sqlite3_reset(s->stream_seq);
    sqlite3_clear_bindings(s->stream_seq);
    return out;
}

int store_stream_stats(store *s, const char *name, uint64_t *seq, uint64_t *event_bytes,
                       uint64_t *state_bytes) {
    sqlite3_bind_text(s->stream_stats, 1, name, -1, SQLITE_STATIC);
    int rc = sqlite3_step(s->stream_stats);
    int out;
    if (rc == SQLITE_ROW) {
        *seq = (uint64_t)sqlite3_column_int64(s->stream_stats, 0);
        *event_bytes = (uint64_t)sqlite3_column_int64(s->stream_stats, 1);
        *state_bytes = (uint64_t)sqlite3_column_int64(s->stream_stats, 2);
        out = 1;
    } else if (rc == SQLITE_DONE) {
        out = 0;
    } else {
        out = fail(s, "stream_stats");
    }
    sqlite3_reset(s->stream_stats);
    sqlite3_clear_bindings(s->stream_stats);
    return out;
}

int store_live_streams(store *s, const char *prefix, store_name_fn fn, void *arg) {
    char bound[1024];
    sqlite3_stmt *st;
    if (prefix_bound(prefix, bound, sizeof bound)) {
        st = s->live_streams;
        sqlite3_bind_text(st, 1, prefix, -1, SQLITE_STATIC);
        sqlite3_bind_text(st, 2, bound, -1, SQLITE_TRANSIENT);
    } else {
        st = s->live_streams_all;
    }
    int rc, out = 0;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        if (fn(arg, (const char *)sqlite3_column_text(st, 0),
               (uint64_t)sqlite3_column_int64(st, 1)) != 0) {
            out = -1;
            break;
        }
    }
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) out = fail(s, "live_streams");
    sqlite3_reset(st);
    sqlite3_clear_bindings(st);
    return out;
}

int store_live_stream(store *s, const char *name, uint64_t *seq) {
    sqlite3_bind_text(s->live_stream, 1, name, -1, SQLITE_STATIC);
    int rc = sqlite3_step(s->live_stream);
    int out;
    if (rc == SQLITE_ROW) {
        *seq = (uint64_t)sqlite3_column_int64(s->live_stream, 0);
        out = 1;
    } else if (rc == SQLITE_DONE) {
        out = 0;
    } else {
        out = fail(s, "live_stream");
    }
    sqlite3_reset(s->live_stream);
    sqlite3_clear_bindings(s->live_stream);
    return out;
}
