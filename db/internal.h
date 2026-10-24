#ifndef PLDB_INTERNAL_H
#define PLDB_INTERNAL_H

#include <pthread.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mpack.h"
#include "pldb.h"
#include "quickjs.h"
#include "walk.h"

/* growable byte buffer */
typedef struct buf {
    uint8_t *p;
    size_t len, cap;
} buf;
void buf_append(buf *b, const void *data, size_t len);
void buf_u32(buf *b, uint32_t v);
void buf_u64(buf *b, uint64_t v);
void buf_free(buf *b);

/* growable list of owned strings */
typedef struct strlist {
    char **v;
    size_t n, cap;
} strlist;
void strlist_push(strlist *l, const char *s);
bool strlist_has(const strlist *l, const char *s);
void strlist_clear(strlist *l);
void strlist_free(strlist *l);
void strlist_sort(strlist *l);

char *xstrdup(const char *s);
void *xmalloc(size_t n);
void die(const char *fmt, ...);

uint32_t pl_crc32c(const void *data, size_t len);
uint64_t pl_fnv1a(const void *data, size_t len, uint64_t h);

/* the length of a mutation's id, a label the client mints */
#define ID_LEN 16

/* where an edit stands in its slice's life, as its envelope carries it: a normal edit applies its
   writes, a birth clears the slice first, and a death clears it and writes nothing */
enum { EDIT_NORMAL = 0, EDIT_BIRTH = 1, EDIT_DEATH = 2 };

/* store.c: one SQLite connection */
typedef struct store store;
int store_open(const char *path, bool writer, store **out, char *err, size_t errlen);
void store_close(store *s);
const char *store_err(store *s);
int store_exec(store *s, const char *sql);
int store_get(store *s, const char *key, uint8_t **val, size_t *len);
int store_set(store *s, const char *key, const uint8_t *val, size_t len);
int store_del(store *s, const char *key);
typedef int (*store_kv_fn)(void *arg, const char *key, const uint8_t *val, size_t len);
int store_scan(store *s, const char *prefix, store_kv_fn fn, void *arg);
int store_del_prefix(store *s, const char *prefix);
/* The kv cursor walks the kv table's keys one way, one walk at a time per connection.  A seek
   forward moves to the first key at or after target, strictly after it when strict, and one in
   reverse to the last key at or before it; a NULL target moves to the first or last key of all.
   A step moves one key on in the seek's direction.  Each answers 1 at a key, 0 past the end of
   the walk, and -1 on an error.  The key and value at the cursor hold until it moves, and
   store_cursor_end lets go of the walk. */
int store_cursor_seek(store *s, bool reverse, const char *target, size_t n, bool strict);
int store_cursor_step(store *s);
const char *store_cursor_key(store *s, size_t *n);
const uint8_t *store_cursor_value(store *s, size_t *n);
void store_cursor_end(store *s);
/* A log row is one edit: the position of its mutation, the slice it edits, its seq there, its
   lifecycle, and its wire encoding whole.  A mutation's edits share its position, one per slice.
   A read hands each row to fn, which answers 0 to go on, a positive number to stop, or a
   negative one to fail the read. */
int store_append(store *s, uint64_t position, const char *slice, uint64_t seq, int lifecycle,
                 const uint8_t *edit, size_t len);
typedef int (*store_log_fn)(void *arg, uint64_t position, const char *slice, const uint8_t *edit,
                            size_t len);
/* the edits with from <= position <= to, by position, then slice */
int store_read_log(store *s, uint64_t from, uint64_t to, store_log_fn fn, void *arg);
/* the edits of one slice, or of the slices whose names start with prefix, with
   from < position < to, by position ascending or descending, then by slice in the same
   direction */
int store_read_slice(store *s, const char *slice, uint64_t from, uint64_t to, bool reverse,
                     store_log_fn fn, void *arg);
int store_read_prefix(store *s, const char *prefix, uint64_t from, uint64_t to, bool reverse,
                      store_log_fn fn, void *arg);
int store_max_position(store *s, uint64_t *out);
/* The series table, keyed by the hex SHA-256 of a series.  store_series_hwm answers 1 and
   the series' mark if the series is known, 0 if not; store_series_mark raises the mark to n
   at least and stamps the series' last decision. */
int store_series_hwm(store *s, const char *key, uint64_t *hwm);
int store_series_mark(store *s, const char *key, uint64_t n, int64_t time);
/* The token keys: each public key tokens are verified against, by id, with the Unix
   milliseconds it was minted.  store_keys walks them oldest first, stopping when fn answers
   nonzero. */
typedef int (*store_key_fn)(void *arg, const char *kid, const uint8_t *pub, size_t len,
                            int64_t minted);
int store_keys(store *s, store_key_fn fn, void *arg);
int store_key_add(store *s, const char *kid, const uint8_t *pub, size_t len, int64_t minted);
int store_key_del(store *s, const char *kid);
/* The slices table: one row per slice ever born, kept across its deaths, with its seq, the
   position of its last edit, the position of its last birth, the position of its death or NULL
   while it is live, and the bytes of its edits in the log and of its keys in the store.  A birth creates or revives the row, and
   must come before the slice's first next_seq. */
int store_slice_birth(store *s, const char *name, uint64_t pos);
int store_slice_death(store *s, const char *name, uint64_t pos);
/* the slice's edits below the position go, and its edit bytes are those of the edits that
   remain */
int store_slice_erase(store *s, const char *name, uint64_t before);
/* the slice's next seq, for an edit at pos, charging the edit's bytes to it */
int store_slice_next_seq(store *s, const char *name, size_t bytes, uint64_t pos, uint64_t *seq);
/* 1 with the slice's seq and whether it is live when it has a row, 0 when it was never born */
int store_slice_state(store *s, const char *name, uint64_t *seq, bool *live);
/* 1 with the slice's seq, its last edit's position, and its byte counters when it has a row, 0
   when it was never born */
int store_slice_stats(store *s, const char *name, uint64_t *seq, uint64_t *pos,
                      uint64_t *edit_bytes, uint64_t *state_bytes);
typedef int (*store_slice_fn)(void *arg, const char *name, uint64_t seq, uint64_t pos, bool live);
/* every slice ever born whose name starts with prefix, by name, with its seq, its last edit's
   position, and whether it is live */
int store_slices_under(store *s, const char *prefix, store_slice_fn fn, void *arg);
/* 1 and the slice's seq if it is live, 0 if unborn or deleted */
int store_live_slice(store *s, const char *name, uint64_t *seq);

/* buffer.c: a mutation's write buffer, the read-write layer a decider, bootstrap, or a plugin's
   run writes through.  It holds each key written once, with its last value's msgpack bytes in
   store format or a deletion, and the slices deleted, each with whether its history goes too.
   Deleting a slice drops the entries under it, so an entry under a deleted slice is a write made
   after the deletion.  Reads see the buffer over the store: an entry wins, and a store key under
   a deleted slice is absent.  Entries keep write order until wbuf_sort orders them by key, which
   a scan or a commit asks for. */
typedef struct wentry {
    char *key;
    size_t n;
    uint8_t *val; /* NULL for a deletion */
    size_t len;
} wentry;
typedef struct wdel {
    char *slice;
    bool erase;
} wdel;
typedef struct wbuf {
    wentry *v;
    size_t n, cap;
    size_t *slots; /* open addressing over v: an entry's index plus one, 0 for an empty slot */
    size_t nslots;
    bool sorted;
    wdel *dels;
    size_t ndels, capdels;
} wbuf;
/* write key's value, copying it, or delete key for a NULL val */
void wbuf_put(wbuf *b, const char *key, size_t n, const uint8_t *val, size_t len);
/* the entry for key, or NULL */
const wentry *wbuf_find(const wbuf *b, const char *key, size_t n);
void wbuf_delete_slice(wbuf *b, const char *slice, bool erase);
/* the deletion of the slice a key belongs to, or NULL when the buffer did not delete it */
const wdel *wbuf_deleted(const wbuf *b, const char *key, size_t n);
/* order the entries by key, bytewise, and the deleted slices by name */
void wbuf_sort(wbuf *b);
/* the first entry in key order at or after key, strictly after when strict; b must be sorted */
size_t wbuf_seek(const wbuf *b, const char *key, size_t n, bool strict);
bool wbuf_empty(const wbuf *b);
void wbuf_clear(wbuf *b);
void wbuf_free(wbuf *b);

/* scan.c: key patterns, the skeleton's KeyPattern compiled, and the walk of the keys one picks
   out.  Text carries its length, since a pattern given by the bundle may hold U+0000. */
typedef struct pattern pattern;
/* the skeleton's compilePattern of a KeyPattern; NULL with a JS exception for a malformed one */
pattern *pattern_from_js(JSContext *ctx, JSValueConst v);
void pattern_free(pattern *p);
/* whether the pattern names a local template, so that its keys share one type */
bool pattern_named(const pattern *p);
/* whether the pattern picks out a key */
bool pattern_matches(const pattern *p, const char *key, size_t n);
/* the keys a walk steps through before it seeks: a SQLite seek costs about as much as 16 steps
   (2.5 us against 0.16 us a row) */
#define SCAN_STEP_BUDGET 16
/* Walk the keys the pattern picks out, as the skeleton's walkPattern does over the kv cursor,
   from just past after when it is not NULL, stepping up to budget keys before a seek.  visit
   sees each key with the cursor on it and answers 1 to go on, 0 to stop, or -1 to fail the
   walk.  Answers 0, or -1 when visit failed or the store did, which store_err tells. */
typedef int (*pattern_visit_fn)(void *arg, const char *key, size_t n);
int pattern_walk(store *s, const pattern *p, bool reverse, const char *after, size_t after_n,
                 size_t budget, pattern_visit_fn visit, void *arg);

/* What one scan batch walked, the skeleton's ScanSpan: its pattern, and the stretch of keys from
   just past from, or the walk's start when it is NULL, to to, or the walk's end. */
typedef struct scan_span {
    pattern *pattern;
    bool reverse;
    char *from, *to;
    size_t from_n, to_n;
} scan_span;
typedef struct span_list {
    scan_span *v;
    size_t n, cap;
} span_list;
/* add a span, taking pattern and copying from and to; the next batch of the last span's walk,
   resuming where it ends under the same pattern, extends that span instead */
void span_list_push(span_list *l, pattern *pattern, bool reverse, const char *from, size_t from_n,
                    const char *to, size_t to_n);
void span_list_clear(span_list *l);
void span_list_free(span_list *l);
/* whether a key written lies inside what a scan batch read */
bool span_covers(const scan_span *s, const char *key, size_t n);
/* whether a key under prefix could lie inside what a scan batch read; true when in doubt */
bool span_may_hold(const scan_span *s, const char *prefix, size_t n);

/* mpjs.c: msgpack <-> plain JS values */
JSValue mpjs_decode(JSContext *ctx, const uint8_t *data, size_t len);
JSValue mpjs_decode_node(JSContext *ctx, mpack_node_t node);
int mpjs_encode(JSContext *ctx, JSValueConst v, buf *out);

/* os.c: the system calls that differ by platform.  os_random fills buf with n random bytes, and
   os_mkdir makes a directory that may exist; each answers 0, or -1 with errno set where the
   platform sets one.  now_ms is the wall clock in Unix milliseconds. */
int os_random(void *buf, size_t n);
int os_mkdir(const char *path);
int64_t now_ms(void);

/* js.c: the QuickJS host */
typedef struct jsrt {
    JSRuntime *rt;
    JSContext *ctx;
    JSValue host;
    store *st;
    schema *sc;   /* the bundle's registry, which every typed value crosses by */
    pldb_hash_fn hasher;  /* bootstrap's hashPassword */
    strlist env_names;    /* the variables bootstrap's env may read */
    jsenv env;
    /* the write buffer of the call running, which reads see over the store, or NULL while a slot
       that only reads runs, which a write fails, naming slot */
    wbuf *wb;
    const char *slot;
    strlist *track_rkeys;
    span_list *track_spans;
    size_t scan_budget; /* the keys a scan steps through before it seeks */
    bool dev;           /* the bundle's DEV: its errors go to clients in full */
    char *bundle_file;  /* the name the bundle's stack frames carry */
    JSValue source_map; /* the bundle's inline source map, parsed, or undefined */
    JSValue map_stack;  /* the bundle's mapStack */
    char err[4096];
} jsrt;

/* open the JS host: host is host.js's source, which the Go layer embeds */
int js_open(jsrt *js, const char *host, size_t hostlen, const char *bundle_path, store *st,
            char *err, size_t errlen);
void js_close(jsrt *js);
JSValue js_principal(jsrt *js, const char *user);
/* The calls that write run over wb, which holds what they wrote when they return.  decide answers
   0 with *reason NULL when it carried the mutation out, and 0 with the reason, malloc'd, when it
   rejected it; each call answers -1 with js->err when the bundle threw. */
int js_decide(jsrt *js, wbuf *wb, JSValueConst data, JSValueConst principal, char **reason);
/* run the bundle's bootstrap, if it has one */
int js_bootstrap(jsrt *js, wbuf *wb);
/* every cron entry of the bundle's cron installs, as install, entry, and spec, three strings each */
int js_cron_entries(jsrt *js, strlist *out);
/* one tick of a cron entry, slot and now in Unix milliseconds, as its install's mutation */
int js_tick(jsrt *js, wbuf *wb, const char *install, const char *entry, int64_t slot,
            int64_t now);
int js_grant(jsrt *js, JSValueConst principal, strlist *out);
int js_lookup(jsrt *js, const uint8_t *ident, size_t len, buf *out);
int64_t js_generation(jsrt *js, JSValueConst principal);
/* the password hash lookup answers for the principal's token, malloc'd into out, or NULL for
   none; -1 when lookup threw */
int js_password_hash(jsrt *js, JSValueConst principal, char **out);

/* names.c: slice names, the selectors a grantor returns, and the characters of a key */
/* whether a string is a slice name: a family, then optionally ':' and its parameters' values
   separated by ',' */
bool slice_name_ok(const char *name);
/* whether a prefix selector's text before its star ("chat:", "chat:acme,") is a family and ':',
   then whole leading values, each followed by ',' */
bool selector_prefix_ok(const char *prefix);
/* whether a key, as its C string, holds no control character and no lone surrogate */
bool key_chars_ok(const char *key);

#endif
