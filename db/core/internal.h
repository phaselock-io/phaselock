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
int64_t now_ms(void);

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
int store_append(store *s, uint64_t position, const char *stream, uint64_t seq,
                 const char *commandid, int64_t servertime, const uint8_t *data, size_t len);
typedef int (*store_log_fn)(void *arg, uint64_t position, const char *stream, uint64_t seq,
                            const char *commandid, int64_t servertime, const uint8_t *data,
                            size_t len);
int store_read_log(store *s, uint64_t from, uint64_t to, store_log_fn fn, void *arg);
int store_read_stream(store *s, const char *stream, uint64_t from, uint64_t to, bool reverse,
                      size_t limit, store_log_fn fn, void *arg);
int store_read_prefix(store *s, const char *prefix, uint64_t from, uint64_t to, bool reverse,
                      size_t limit, store_log_fn fn, void *arg);
int store_max_position(store *s, uint64_t *out);
int store_command_position(store *s, const char *id, uint64_t *pos);
int store_command_insert(store *s, const char *id, uint64_t pos);
int store_stream_live(store *s, const char *name);
int store_stream_birth(store *s, const char *name, uint64_t pos);
int store_stream_death(store *s, const char *name, uint64_t pos);
int store_stream_next_seq(store *s, const char *name, size_t bytes, uint64_t *seq);
int store_stream_stats(store *s, const char *name, uint64_t *seq, uint64_t *event_bytes,
                       uint64_t *state_bytes);
typedef int (*store_name_fn)(void *arg, const char *name, uint64_t seq);
int store_live_streams(store *s, const char *prefix, store_name_fn fn, void *arg);
/* 1 and the stream's seq if it is live, 0 if unborn or dead */
int store_live_stream(store *s, const char *name, uint64_t *seq);

/* mpjs.c: msgpack <-> plain JS values */
JSValue mpjs_decode(JSContext *ctx, const uint8_t *data, size_t len);
JSValue mpjs_decode_node(JSContext *ctx, mpack_node_t node);
int mpjs_encode(JSContext *ctx, JSValueConst v, buf *out);

/* one slice's templates, from its SliceReducer */
typedef struct slice_names {
    char *family;
    char *stream; /* the family template */
    strlist keys; /* the key templates */
} slice_names;

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
    strlist *track_rkeys;
    strlist *track_rprefixes;
    strlist *track_wkeys;
    slice_names *slices; /* every reducer's templates */
    size_t nslices;
    /* while a reducer runs, its slice, whose key templates every key it writes must fill, and the
       length of the "<stream>!" prefix of those keys */
    const slice_names *reducing;
    size_t reducing_skip;
    bool dev;           /* the bundle's DEV: its errors go to clients in full */
    char *bundle_file;  /* the name the bundle's stack frames carry */
    JSValue source_map; /* the bundle's inline source map, parsed, or undefined */
    JSValue map_stack;  /* the bundle's mapStack */
    char err[4096];
} jsrt;

typedef struct pc_item {
    char *stream;
    bool death;
    JSValue event;
    buf bytes;
} pc_item;

typedef struct pc_result {
    char *reason;
    pc_item *items;
    size_t n;
} pc_result;

int js_open(jsrt *js, const char *bundle_path, store *st, char *err, size_t errlen);
void js_close(jsrt *js);
JSValue js_principal(jsrt *js, const char *user, const char *const *traits, int n);
/* run the bundle's bootstrap, if it has one, collecting what it emits */
int js_bootstrap(jsrt *js, pc_result *out);
int js_precommit(jsrt *js, const char *id, JSValueConst data, JSValueConst principal,
                 pc_result *out);
void pc_result_free(jsrt *js, pc_result *r);
int js_reduce(jsrt *js, const char *family, const char *stream, JSValueConst events);
int js_maysee(jsrt *js, JSValueConst principal, strlist *out);
int js_lookup(jsrt *js, const uint8_t *ident, size_t len, buf *out);
int64_t js_generation(jsrt *js, JSValueConst principal);

/* names.c: stream names and keys against their slice's templates */
/* the slice whose family a stream name's first segment names, or NULL */
const slice_names *slice_of(const jsrt *js, const char *stream);
/* whether a stream name fills its family's template */
bool stream_fills(const jsrt *js, const char *name);
/* whether a wildcard ref's text before its star ("chat:", "chat:acme,") covers whole parameters
   of its family's template: the family alone, or the family and parameters other than the
   terminal one */
bool ref_prefix_fills(const jsrt *js, const char *prefix);
/* whether a local key fills the key template its name picks */
bool key_fills(const slice_names *sl, const char *key);
/* whether a key, as its C string, holds no control character and no lone surrogate */
bool key_chars_ok(const char *key);

#endif
