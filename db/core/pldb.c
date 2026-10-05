/* The core: request and result queues, the txn loop, maySee registrations,
   and the reader-side calls. */

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include "internal.h"

enum { REQ_SUBMIT = 1, REQ_REGISTER, REQ_UNREGISTER, REQ_LOOKUP };

/* a formatted string, malloc'd */
static char *strf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    char *s = xmalloc((size_t)n + 1);
    va_start(ap, fmt);
    vsnprintf(s, (size_t)n + 1, fmt, ap);
    va_end(ap);
    return s;
}

typedef struct req {
    int kind;
    uint64_t reqid, conn;
    char *user;
    strlist traits;
    int64_t gen;
    uint8_t *body;
    size_t len;
    struct req *next;
} req;

/* one registered maySee query, shared by every connection with the same
   principal */
typedef struct reg {
    char *canon;
    char *user;
    strlist traits;
    strlist prefixes;
    char hash[17]; /* of prefixes, so a change to the set is one comparison */
    strlist rkeys, rprefixes;
    uint64_t *conns;
    size_t nconns, capconns;
    char *failure; /* what its connections are answered with when maySee failed, or NULL */
    struct reg *next;
} reg;

struct pldb {
    char *dir;
    store *w;
    store *r;
    pthread_mutex_t rmu;
    jsrt js;
    pldb_hash_fn hasher;
    char *epoch;

    pthread_mutex_t qmu;
    pthread_cond_t qcv;
    req *qhead, *qtail;
    bool stop;

    pthread_mutex_t resmu;
    pthread_cond_t rescv;
    pldb_result *rhead, *rtail;

    pthread_t thread;
    bool started;
    uint64_t position;
    reg *regs;
};

/* item lists for commit results and log reads */
typedef struct items {
    pldb_item *v;
    size_t n, cap;
} items;

static pldb_item *items_push(items *it) {
    if (it->n == it->cap) {
        it->cap = it->cap ? it->cap * 2 : 16;
        it->v = realloc(it->v, it->cap * sizeof(pldb_item));
        if (!it->v) die("out of memory");
    }
    pldb_item *p = &it->v[it->n++];
    memset(p, 0, sizeof *p);
    return p;
}

void pldb_items_free(pldb_item *items, size_t n) {
    for (size_t i = 0; i < n; i++) {
        free(items[i].stream);
        free(items[i].commandid);
        free(items[i].data);
    }
    free(items);
}

void pldb_free(void *p) { free(p); }

/* encode [ [position, stream, seq, commandid, servertime], data ] */
static void encode_wire(buf *out, uint64_t position, const char *stream, uint64_t seq,
                        const char *commandid, int64_t servertime, const uint8_t *data,
                        size_t len) {
    char *d = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &d, &size);
    mpack_start_array(&w, 2);
    mpack_start_array(&w, 5);
    mpack_write_u64(&w, position);
    mpack_write_cstr(&w, stream);
    mpack_write_u64(&w, seq);
    mpack_write_cstr(&w, commandid);
    mpack_write_timestamp(&w, servertime / 1000, (uint32_t)(servertime % 1000) * 1000000u);
    mpack_finish_array(&w);
    mpack_write_object_bytes(&w, (const char *)data, len);
    mpack_finish_array(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) die("encode_wire");
    buf_append(out, d, size);
    free(d);
}

static void item_set(pldb_item *it, uint64_t position, const char *stream, uint64_t seq,
                     const char *commandid, int64_t servertime, const uint8_t *data, size_t len) {
    it->stream = xstrdup(stream);
    it->commandid = xstrdup(commandid);
    it->position = position;
    buf b = {0};
    encode_wire(&b, position, stream, seq, commandid, servertime, data, len);
    it->data = b.p;
    it->len = b.len;
}

/* What a client is told of a failure that is a bug, as opposed to a rejection: the whole error
   when the bundle is a dev build, and "internal error" otherwise.  The whole error goes to the
   log either way, under the command it failed when it failed one.  Takes msg. */
static char *bug_reason(const pldb *db, const char *id, char *msg) {
    if (id) fprintf(stderr, "pldb: command %s: %s\n", id, msg);
    else fprintf(stderr, "pldb: %s\n", msg);
    if (db->js.dev) return msg;
    free(msg);
    return xstrdup("internal error");
}

// results //////////////////////////////////////////////////////////////////

static pldb_result *result_new(int kind) {
    pldb_result *r = xmalloc(sizeof *r);
    memset(r, 0, sizeof *r);
    r->kind = kind;
    return r;
}

static void results_push(pldb *db, pldb_result *r) {
    r->next = NULL;
    pthread_mutex_lock(&db->resmu);
    if (db->rtail) db->rtail->next = r;
    else db->rhead = r;
    db->rtail = r;
    pthread_cond_signal(&db->rescv);
    pthread_mutex_unlock(&db->resmu);
}

pldb_result *pldb_pop(pldb *db) {
    pthread_mutex_lock(&db->resmu);
    while (!db->rhead) pthread_cond_wait(&db->rescv, &db->resmu);
    pldb_result *r = db->rhead;
    db->rhead = r->next;
    if (!db->rhead) db->rtail = NULL;
    pthread_mutex_unlock(&db->resmu);
    r->next = NULL;
    return r;
}

static void free_strings(char **v, size_t n) {
    for (size_t i = 0; i < n; i++) free(v[i]);
    free(v);
}

void pldb_result_free(pldb_result *r) {
    if (!r) return;
    pldb_items_free(r->items, r->nitems);
    free(r->buf);
    free_strings(r->prefixes, r->nprefixes);
    free(r->errmsg);
    free(r);
}

static char **strings_copy(const strlist *l) {
    char **v = xmalloc(sizeof(char *) * (l->n ? l->n : 1));
    for (size_t i = 0; i < l->n; i++) v[i] = xstrdup(l->v[i]);
    return v;
}

// requests /////////////////////////////////////////////////////////////////

static req *req_new(int kind, uint64_t reqid, const char *user, const char *const *traits,
                    int ntraits, int64_t gen) {
    req *q = xmalloc(sizeof *q);
    memset(q, 0, sizeof *q);
    q->kind = kind;
    q->reqid = reqid;
    q->user = user ? xstrdup(user) : NULL;
    for (int i = 0; i < ntraits; i++) strlist_push(&q->traits, traits[i]);
    q->gen = gen;
    return q;
}

static void req_free(req *q) {
    free(q->user);
    strlist_free(&q->traits);
    free(q->body);
    free(q);
}

static void enqueue(pldb *db, req *q) {
    q->next = NULL;
    pthread_mutex_lock(&db->qmu);
    if (db->qtail) db->qtail->next = q;
    else db->qhead = q;
    db->qtail = q;
    pthread_cond_signal(&db->qcv);
    pthread_mutex_unlock(&db->qmu);
}

int pldb_submit(pldb *db, uint64_t reqid, const char *user, const char *const *traits,
                int ntraits, int64_t gen, const uint8_t *body, size_t len) {
    req *q = req_new(REQ_SUBMIT, reqid, user, traits, ntraits, gen);
    q->body = xmalloc(len);
    memcpy(q->body, body, len);
    q->len = len;
    enqueue(db, q);
    return 0;
}

int pldb_register(pldb *db, uint64_t reqid, uint64_t conn, const char *user,
                  const char *const *traits, int ntraits, int64_t gen) {
    req *q = req_new(REQ_REGISTER, reqid, user, traits, ntraits, gen);
    q->conn = conn;
    enqueue(db, q);
    return 0;
}

int pldb_unregister(pldb *db, uint64_t conn) {
    req *q = req_new(REQ_UNREGISTER, 0, NULL, NULL, 0, -1);
    q->conn = conn;
    enqueue(db, q);
    return 0;
}

int pldb_lookup(pldb *db, uint64_t reqid, const uint8_t *ident, size_t len) {
    req *q = req_new(REQ_LOOKUP, reqid, NULL, NULL, 0, -1);
    q->body = xmalloc(len);
    memcpy(q->body, ident, len);
    q->len = len;
    enqueue(db, q);
    return 0;
}

// maySee registrations /////////////////////////////////////////////////////

static char *canon_principal(const char *user, const strlist *traits) {
    strlist sorted = {0};
    for (size_t i = 0; i < traits->n; i++) strlist_push(&sorted, traits->v[i]);
    strlist_sort(&sorted);
    buf b = {0};
    buf_append(&b, user ? "u:" : "anon", user ? 2 : 4);
    if (user) buf_append(&b, user, strlen(user));
    for (size_t i = 0; i < sorted.n; i++) {
        buf_append(&b, "\x1f", 1);
        buf_append(&b, sorted.v[i], strlen(sorted.v[i]));
    }
    buf_append(&b, "", 1);
    strlist_free(&sorted);
    return (char *)b.p;
}

static void view_hash(const strlist *prefixes, char out[17]) {
    strlist sorted = {0};
    for (size_t i = 0; i < prefixes->n; i++)
        if (!strlist_has(&sorted, prefixes->v[i])) strlist_push(&sorted, prefixes->v[i]);
    strlist_sort(&sorted);
    uint64_t h = 14695981039346656037ull;
    for (size_t i = 0; i < sorted.n; i++) {
        h = pl_fnv1a(sorted.v[i], strlen(sorted.v[i]) + 1, h);
    }
    strlist_free(&sorted);
    snprintf(out, 17, "%016llx", (unsigned long long)h);
}

static bool normalize_bundle_ref(const jsrt *js, char *ref);

/* Run maySee for the registration, replacing its prefixes and read-set.  A maySee that throws or
   returns a malformed ref is a bug, and the registration fails closed: it grants nothing, and
   every connection of it is answered with the failure. */
static int reg_evaluate(pldb *db, reg *g) {
    JSValue principal = js_principal(&db->js, g->user, (const char *const *)g->traits.v, (int)g->traits.n);
    strlist_clear(&g->prefixes);
    strlist_clear(&g->rkeys);
    strlist_clear(&g->rprefixes);
    db->js.track_rkeys = &g->rkeys;
    db->js.track_rprefixes = &g->rprefixes;
    int rc = js_maysee(&db->js, principal, &g->prefixes);
    db->js.track_rkeys = NULL;
    db->js.track_rprefixes = NULL;
    JS_FreeValue(db->js.ctx, principal);

    // every ref in wire form, or the first failure
    char *msg = rc ? strf("maySee failed: %s", db->js.err) : NULL;
    for (size_t i = 0; !msg && i < g->prefixes.n; i++) {
        if (!normalize_bundle_ref(&db->js, g->prefixes.v[i])) {
            msg = strf("maySee returned a malformed ref: %s", g->prefixes.v[i]);
        }
    }
    free(g->failure);
    g->failure = NULL;
    if (msg) {
        g->failure = bug_reason(db, NULL, msg);
        strlist_clear(&g->prefixes);
    }
    view_hash(&g->prefixes, g->hash);
    return g->failure ? -1 : 0;
}

static reg *reg_find(pldb *db, const char *canon) {
    for (reg *g = db->regs; g; g = g->next)
        if (strcmp(g->canon, canon) == 0) return g;
    return NULL;
}

static void reg_free(reg *g) {
    free(g->canon);
    free(g->user);
    strlist_free(&g->traits);
    strlist_free(&g->prefixes);
    strlist_free(&g->rkeys);
    strlist_free(&g->rprefixes);
    free(g->conns);
    free(g->failure);
    free(g);
}

static void reg_attach(reg *g, uint64_t conn) {
    if (g->nconns == g->capconns) {
        g->capconns = g->capconns ? g->capconns * 2 : 4;
        g->conns = realloc(g->conns, g->capconns * sizeof(uint64_t));
        if (!g->conns) die("out of memory");
    }
    g->conns[g->nconns++] = conn;
}

/* A wire ref is a stream name, "family.*" for every stream under
   "family.", or "*" for every stream.  Wildcards are the prefix they
   cover, "" for "*". */
static bool is_wildcard(const char *ref) {
    size_t n = strlen(ref);
    return (n == 1 && ref[0] == '*') || (n > 2 && ref[n - 2] == '.' && ref[n - 1] == '*');
}

static void ref_prefix(const char *ref, char *out, size_t cap) {
    size_t n = strlen(ref);
    if (n == 1) n = 0; /* "*" */
    else n -= 1;       /* drop the star, keep the dot */
    if (n + 1 > cap) n = cap - 1;
    memcpy(out, ref, n);
    out[n] = 0;
}

/* maySee returns refs with a terminator on every entry: "family.*", "*",
   or "name/" for an exact stream.  Strips the slash into wire form;
   false on a malformed entry, one whose name does not fill its family's
   template, or a wildcard that cuts into a parameter. */
static bool normalize_bundle_ref(const jsrt *js, char *ref) {
    size_t n = strlen(ref);
    if (strcmp(ref, "*") == 0) return true;
    if (n > 1 && ref[n - 1] == '/') {
        ref[n - 1] = 0;
        return stream_fills(js, ref);
    }
    if (!is_wildcard(ref)) return false;
    ref[n - 2] = 0; /* the name before the dot */
    bool ok = ref_prefix_fills(js, ref);
    ref[n - 2] = '.';
    return ok;
}

/* what maySee allows, sorted and unique, or its failure */
static pldb_result *view_result(const reg *g, uint64_t conn, uint64_t position) {
    pldb_result *r = result_new(PLDB_R_VIEW);
    r->conn = conn;
    r->position = position;
    if (g->failure) {
        r->status = 500;
        r->errmsg = xstrdup(g->failure);
        return r;
    }
    strlist sorted = {0};
    for (size_t i = 0; i < g->prefixes.n; i++)
        if (!strlist_has(&sorted, g->prefixes.v[i])) strlist_push(&sorted, g->prefixes.v[i]);
    strlist_sort(&sorted);
    r->prefixes = strings_copy(&sorted);
    r->nprefixes = sorted.n;
    strlist_free(&sorted);
    return r;
}

/* the stale-token check: -1 stale, 0 ok */
static int check_generation(pldb *db, const char *user, const strlist *traits, int64_t gen) {
    if (!user || gen < 0) return 0;
    JSValue principal = js_principal(&db->js, user, (const char *const *)traits->v, (int)traits->n);
    int64_t g = js_generation(&db->js, principal);
    JS_FreeValue(db->js.ctx, principal);
    if (g == -2) {
        fprintf(stderr, "pldb: generation lookup failed: %s\n", db->js.err);
        return -1;
    }
    /* a token speaks only for an existing account at its current generation */
    if (g == -1) return -1;
    return g == gen ? 0 : -1;
}

static void handle_register(pldb *db, req *q, pldb_result **after_tail) {
    pldb_result *r;
    if (check_generation(db, q->user, &q->traits, q->gen)) {
        r = result_new(PLDB_R_VIEW);
        r->status = 401;
        r->conn = q->conn;
        r->reqid = q->reqid;
        (*after_tail)->next = r;
        *after_tail = r;
        return;
    }
    char *canon = canon_principal(q->user, &q->traits);
    reg *g = reg_find(db, canon);
    if (!g) {
        g = xmalloc(sizeof *g);
        memset(g, 0, sizeof *g);
        g->canon = canon;
        g->user = q->user ? xstrdup(q->user) : NULL;
        for (size_t i = 0; i < q->traits.n; i++) strlist_push(&g->traits, q->traits.v[i]);
        reg_evaluate(db, g);
        g->next = db->regs;
        db->regs = g;
    } else {
        free(canon);
    }
    reg_attach(g, q->conn);
    r = view_result(g, q->conn, db->position);
    r->reqid = q->reqid;
    (*after_tail)->next = r;
    *after_tail = r;
}

static void handle_unregister(pldb *db, req *q) {
    reg **link = &db->regs;
    while (*link) {
        reg *g = *link;
        for (size_t i = 0; i < g->nconns; i++) {
            if (g->conns[i] == q->conn) {
                g->conns[i] = g->conns[--g->nconns];
                break;
            }
        }
        if (g->nconns == 0) {
            *link = g->next;
            reg_free(g);
        } else {
            link = &g->next;
        }
    }
}

static bool has_prefix(const char *s, const char *prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

/* after a batch's writes: re-run every maySee whose read-set was touched,
   and emit a view result to every connection of a registration whose
   prefixes changed */
static void invalidate_views(pldb *db, const strlist *written, const strlist *deleted,
                             pldb_result **head, pldb_result **tail) {
    for (reg *g = db->regs; g; g = g->next) {
        bool dirty = false;
        for (size_t i = 0; i < written->n && !dirty; i++) {
            const char *k = written->v[i];
            if (strlist_has(&g->rkeys, k)) dirty = true;
            for (size_t j = 0; j < g->rprefixes.n && !dirty; j++)
                if (has_prefix(k, g->rprefixes.v[j])) dirty = true;
        }
        for (size_t i = 0; i < deleted->n && !dirty; i++) {
            const char *p = deleted->v[i];
            for (size_t j = 0; j < g->rkeys.n && !dirty; j++)
                if (has_prefix(g->rkeys.v[j], p)) dirty = true;
            for (size_t j = 0; j < g->rprefixes.n && !dirty; j++)
                if (has_prefix(g->rprefixes.v[j], p) || has_prefix(p, g->rprefixes.v[j])) dirty = true;
        }
        if (!dirty) continue;
        char old_hash[17];
        memcpy(old_hash, g->hash, sizeof old_hash);
        reg_evaluate(db, g);
        /* the whole set goes out on every change, and a failure always;
           the server cuts a set down to each connection's wants and
           decides whether that view changed */
        if (g->failure || strcmp(old_hash, g->hash) != 0) {
            for (size_t i = 0; i < g->nconns; i++) {
                pldb_result *r = view_result(g, g->conns[i], db->position);
                if (*tail) (*tail)->next = r;
                else *head = r;
                *tail = r;
            }
        }
    }
}

// the write path ///////////////////////////////////////////////////////////

static const uint8_t BIRTH[] = {0x81, 0xa4, '$', 's', 'y', 's', 0xa5, 'b', 'i', 'r', 't', 'h'};
static const uint8_t DEATH[] = {0x81, 0xa4, '$', 's', 'y', 's', 0xa5, 'd', 'e', 'a', 't', 'h'};

typedef struct batch {
    int64_t servertime;
    items commit;
    strlist written;
    strlist deleted;
} batch;

/* the stream row must exist: births create it before their event */
static void append_event(pldb *db, batch *b, const char *stream, const char *commandid,
                         const uint8_t *data, size_t len) {
    uint64_t pos = ++db->position;
    uint64_t seq;
    if (store_stream_next_seq(db->w, stream, len, &seq)) die("next_seq: %s", store_err(db->w));
    if (store_append(db->w, pos, stream, seq, commandid, b->servertime, data, len))
        die("append: %s", store_err(db->w));
    item_set(items_push(&b->commit), pos, stream, seq, commandid, b->servertime, data, len);
}

static void family_of(const char *stream, char *out, size_t cap) {
    const char *dot = strchr(stream, '.');
    size_t n = dot ? (size_t)(dot - stream) : strlen(stream);
    if (n >= cap) n = cap - 1;
    memcpy(out, stream, n);
    out[n] = 0;
}

/* one command: returns the outcome as an mpack write into w */
/* the OCC check: every expected stream's seq must be exactly what the
   client names (0 for never born).  Writes a conflict outcome listing each
   mismatched stream's actual seq and returns true when any differs. */
static bool check_expect(pldb *db, mpack_writer_t *w, JSValueConst expect) {
    JSContext *ctx = db->js.ctx;
    if (!JS_IsObject(expect)) return false;
    JSPropertyEnum *tab = NULL;
    uint32_t n = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &n, expect, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    char *names[n ? n : 1];
    uint64_t current[n ? n : 1];
    size_t nconflicts = 0;
    for (uint32_t i = 0; i < n; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        JSValue v = JS_GetProperty(ctx, expect, tab[i].atom);
        int64_t want = -1;
        JS_ToInt64(ctx, &want, v);
        JS_FreeValue(ctx, v);
        if (!name) continue;
        uint64_t seq = 0, eb, sb;
        int rc = store_stream_stats(db->w, name, &seq, &eb, &sb);
        if (rc < 0) die("stream_stats: %s", store_err(db->w));
        if ((int64_t)seq != want) {
            names[nconflicts] = xstrdup(name);
            current[nconflicts++] = seq;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, tab, n);
    if (nconflicts == 0) return false;
    mpack_start_array(w, 2);
    mpack_write_cstr(w, "conflict");
    mpack_start_map(w, (uint32_t)nconflicts);
    for (size_t i = 0; i < nconflicts; i++) {
        mpack_write_cstr(w, names[i]);
        mpack_write_u64(w, current[i]);
        free(names[i]);
    }
    mpack_finish_map(w);
    mpack_finish_array(w);
    return true;
}

/* Append a command's outputs as one atom and fold them, inside a savepoint named cmd that the
   caller releases on success.  Births come before a born stream's first event, deaths clear the
   stream's keys, and each stream's events reach its family's reducer as one run.  Frees pc.
   Answers NULL, or why the atom was rolled back. */
static char *apply_outputs(pldb *db, batch *b, const char *id, pc_result *pc) {
    JSContext *ctx = db->js.ctx;
    char *reason = NULL;
    uint64_t start = db->position;
    size_t commit_start = b->commit.n;
    size_t written_start = b->written.n, deleted_start = b->deleted.n;
    if (store_exec(db->w, "SAVEPOINT cmd")) die("savepoint: %s", store_err(db->w));

    /* append events, grouping them per stream for the reducers */
    typedef struct group {
        char *stream;
        JSValue events;
        uint32_t n;
    } group;
    group *groups = xmalloc(sizeof(group) * (pc->n ? pc->n : 1));
    size_t ngroups = 0;
    for (size_t i = 0; i < pc->n; i++) {
        pc_item *it = &pc->items[i];
        int live = store_stream_live(db->w, it->stream);
        if (live < 0) die("stream_live: %s", store_err(db->w));
        if (it->death) {
            if (!live) continue;
            append_event(db, b, it->stream, id, DEATH, sizeof DEATH);
            if (store_stream_death(db->w, it->stream, db->position)) die("death: %s", store_err(db->w));
            char prefix[1024];
            snprintf(prefix, sizeof prefix, "%s/", it->stream);
            if (store_del_prefix(db->w, prefix)) die("del_prefix: %s", store_err(db->w));
            strlist_push(&b->deleted, prefix);
            continue;
        }
        if (!live) {
            if (store_stream_birth(db->w, it->stream, db->position + 1)) die("birth: %s", store_err(db->w));
            append_event(db, b, it->stream, id, BIRTH, sizeof BIRTH);
        }
        append_event(db, b, it->stream, id, it->bytes.p, it->bytes.len);
        group *g = NULL;
        for (size_t j = 0; j < ngroups; j++)
            if (strcmp(groups[j].stream, it->stream) == 0) g = &groups[j];
        if (!g) {
            g = &groups[ngroups++];
            g->stream = it->stream;
            g->events = JS_NewArray(ctx);
            g->n = 0;
        }
        JS_DefinePropertyValueUint32(ctx, g->events, g->n++, JS_DupValue(ctx, it->event), JS_PROP_C_W_E);
    }

    /* fold */
    db->js.track_wkeys = &b->written;
    for (size_t j = 0; j < ngroups && !reason; j++) {
        char family[256];
        family_of(groups[j].stream, family, sizeof family);
        if (js_reduce(&db->js, family, groups[j].stream, groups[j].events) < 0) {
            reason = bug_reason(db, id, strf("reducer error: %s", db->js.err));
        }
    }
    db->js.track_wkeys = NULL;
    for (size_t j = 0; j < ngroups; j++) JS_FreeValue(ctx, groups[j].events);
    free(groups);
    pc_result_free(&db->js, pc);

    if (reason) {
        if (store_exec(db->w, "ROLLBACK TO cmd") || store_exec(db->w, "RELEASE cmd"))
            die("rollback: %s", store_err(db->w));
        db->position = start;
        for (size_t i = commit_start; i < b->commit.n; i++) {
            free(b->commit.v[i].stream);
            free(b->commit.v[i].commandid);
            free(b->commit.v[i].data);
        }
        b->commit.n = commit_start;
        while (b->written.n > written_start) free(b->written.v[--b->written.n]);
        while (b->deleted.n > deleted_start) free(b->deleted.v[--b->deleted.n]);
        return reason;
    }
    return NULL;
}

static void run_command(pldb *db, batch *b, mpack_writer_t *w, const char *id, JSValueConst data,
                        JSValueConst expect, JSValueConst principal) {
    uint64_t pos;
    int rc = store_command_position(db->w, id, &pos);
    if (rc < 0) die("dedup: %s", store_err(db->w));
    if (rc == 1) {
        mpack_start_array(w, 2);
        mpack_write_cstr(w, "dup");
        mpack_write_u64(w, pos);
        mpack_finish_array(w);
        return;
    }
    if (check_expect(db, w, expect)) return;
    char *reason = NULL;
    pc_result pc = {0};
    if (js_precommit(&db->js, id, data, principal, &pc)) {
        reason = bug_reason(db, id, strf("precommit error: %s", db->js.err));
    } else if (pc.reason) {
        reason = pc.reason;
        pc.reason = NULL;
    }
    if (!reason) {
        for (size_t i = 0; i < pc.n && !reason; i++)
            if (!stream_fills(&db->js, pc.items[i].stream)) {
                reason = bug_reason(db, id, strf("invalid stream name: %s", pc.items[i].stream));
            }
    }
    if (reason) {
        pc_result_free(&db->js, &pc);
        mpack_start_array(w, 2);
        mpack_write_cstr(w, "reject");
        mpack_write_cstr(w, reason);
        mpack_finish_array(w);
        free(reason);
        return;
    }

    reason = apply_outputs(db, b, id, &pc);
    if (reason) {
        mpack_start_array(w, 2);
        mpack_write_cstr(w, "reject");
        mpack_write_cstr(w, reason);
        mpack_finish_array(w);
        free(reason);
        return;
    }
    if (store_command_insert(db->w, id, db->position)) die("command_insert: %s", store_err(db->w));
    if (store_exec(db->w, "RELEASE cmd")) die("release: %s", store_err(db->w));
    mpack_start_array(w, 2);
    mpack_write_cstr(w, "ack");
    mpack_write_u64(w, db->position);
    mpack_finish_array(w);
}

static void handle_submit(pldb *db, batch *b, req *q, pldb_result **after_tail) {
    pldb_result *r = result_new(PLDB_R_OUTCOME);
    r->reqid = q->reqid;
    (*after_tail)->next = r;
    *after_tail = r;
    if (check_generation(db, q->user, &q->traits, q->gen)) {
        r->status = 401;
        return;
    }
    JSContext *ctx = db->js.ctx;
    JSValue principal = js_principal(&db->js, q->user, (const char *const *)q->traits.v, (int)q->traits.n);

    char *data = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    mpack_build_array(&w);

    /* walk the prepared [id, data, expect?] values, each already checked */
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)q->body, q->len);
    long commands = schema_commands(db->js.sc);
    char why[512];
    for (size_t consumed = 0; consumed < q->len;) {
        mpack_tree_parse(&tree);
        if (mpack_tree_error(&tree) != mpack_ok) die("prepared body: malformed msgpack");
        consumed += mpack_tree_size(&tree);
        mpack_node_t pair = mpack_tree_root(&tree);
        mpack_node_t idn = mpack_node_array_at(pair, 0);
        size_t idlen = mpack_node_strlen(idn);
        char *id = xmalloc(idlen + 1);
        memcpy(id, mpack_node_str(idn), idlen);
        id[idlen] = 0;
        JSValue datav = walk_to_js(ctx, db->js.sc, mpack_node_array_at(pair, 1), commands, true, why,
                                   sizeof why);
        JSValue expectv = JS_UNDEFINED;
        if (mpack_node_array_length(pair) > 2) expectv = mpjs_decode_node(ctx, mpack_node_array_at(pair, 2));
        if (JS_IsException(datav) || JS_IsException(expectv)) {
            if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
            mpack_start_array(&w, 2);
            mpack_write_cstr(&w, "reject");
            mpack_write_cstr(&w, JS_IsException(datav) ? why : "malformed expect");
            mpack_finish_array(&w);
        } else {
            run_command(db, b, &w, id, datav, expectv, principal);
        }
        free(id);
        JS_FreeValue(ctx, datav);
        JS_FreeValue(ctx, expectv);
    }
    mpack_tree_destroy(&tree);
    mpack_complete_array(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) die("outcomes encode");
    r->buf = (uint8_t *)data;
    r->len = size;
    JS_FreeValue(ctx, principal);
}

static void handle_lookup(pldb *db, req *q, pldb_result **after_tail) {
    pldb_result *r = result_new(PLDB_R_LOOKUP);
    r->reqid = q->reqid;
    buf out = {0};
    if (js_lookup(&db->js, q->body, q->len, &out)) {
        r->status = 500;
        r->errmsg = bug_reason(db, NULL, strf("lookup failed: %s", db->js.err));
    } else {
        r->buf = out.p;
        r->len = out.len;
    }
    (*after_tail)->next = r;
    *after_tail = r;
}

static void run_batch(pldb *db, req *head) {
    batch b = {0};
    b.servertime = now_ms();
    if (store_exec(db->w, "BEGIN IMMEDIATE")) die("begin: %s", store_err(db->w));

    pldb_result after_head = {0};
    pldb_result *after_tail = &after_head;
    for (req *q = head; q; q = q->next) {
        switch (q->kind) {
        case REQ_SUBMIT:
            handle_submit(db, &b, q, &after_tail);
            break;
        case REQ_REGISTER:
            handle_register(db, q, &after_tail);
            break;
        case REQ_UNREGISTER:
            handle_unregister(db, q);
            break;
        case REQ_LOOKUP:
            handle_lookup(db, q, &after_tail);
            break;
        }
    }
    pldb_result *views = NULL, *views_tail = NULL;
    invalidate_views(db, &b.written, &b.deleted, &views, &views_tail);
    if (store_exec(db->w, "COMMIT")) die("commit: %s", store_err(db->w));

    while (views) {
        pldb_result *r = views;
        views = r->next;
        results_push(db, r);
    }
    if (b.commit.n) {
        pldb_result *r = result_new(PLDB_R_COMMIT);
        r->position = db->position;
        r->items = b.commit.v;
        r->nitems = b.commit.n;
        results_push(db, r);
    } else {
        free(b.commit.v);
    }
    for (pldb_result *r = after_head.next; r;) {
        pldb_result *next = r->next;
        r->position = db->position;
        results_push(db, r);
        r = next;
    }
    strlist_free(&b.written);
    strlist_free(&b.deleted);
    while (head) {
        req *next = head->next;
        req_free(head);
        head = next;
    }
}

static void *txn_loop(void *arg) {
    pldb *db = arg;
    JS_UpdateStackTop(db->js.rt);
    while (true) {
        pthread_mutex_lock(&db->qmu);
        while (!db->qhead && !db->stop) pthread_cond_wait(&db->qcv, &db->qmu);
        if (db->stop && !db->qhead) {
            pthread_mutex_unlock(&db->qmu);
            break;
        }
        req *head = db->qhead;
        db->qhead = db->qtail = NULL;
        pthread_mutex_unlock(&db->qmu);
        run_batch(db, head);
    }
    return NULL;
}

// open / close /////////////////////////////////////////////////////////////

/* The epoch names this log instance: 32 hex digits minted the first time a data directory is
   opened and kept in <dir>/epoch.  Positions mean nothing across epochs, so a copy of a data
   directory that is to diverge from the original must get a fresh one. */
static int load_epoch(const char *dir, char **out, char *err, size_t errlen) {
    char path[2048], tmp[2048], hex[33];
    snprintf(path, sizeof path, "%s/epoch", dir);
    FILE *f = fopen(path, "r");
    if (f) {
        size_t n = fread(hex, 1, 32, f);
        fclose(f);
        if (n != 32) {
            snprintf(err, errlen, "%s: not an epoch", path);
            return -1;
        }
        hex[32] = 0;
        *out = xstrdup(hex);
        return 0;
    }
    unsigned char raw[16];
    FILE *r = fopen("/dev/urandom", "r");
    if (!r || fread(raw, 1, sizeof raw, r) != sizeof raw) {
        if (r) fclose(r);
        snprintf(err, errlen, "/dev/urandom: %s", strerror(errno));
        return -1;
    }
    fclose(r);
    for (size_t i = 0; i < sizeof raw; i++) snprintf(hex + 2 * i, 3, "%02x", raw[i]);
    snprintf(tmp, sizeof tmp, "%s/epoch.tmp", dir);
    f = fopen(tmp, "w");
    if (!f || fwrite(hex, 1, 32, f) != 32 || fclose(f) || rename(tmp, path)) {
        snprintf(err, errlen, "%s: %s", path, strerror(errno));
        return -1;
    }
    *out = xstrdup(hex);
    return 0;
}

/* the command id bootstrap's atom carries */
#define BOOTSTRAP_ID "bootstrap"

/* On an empty log, the bundle's bootstrap seeds it: what it emits lands as one atom through the
   ordinary append and fold, before anything is served.  A bootstrap that throws, or emits to a
   malformed stream, fails the open. */
static int run_bootstrap(pldb *db, char *err, size_t errlen) {
    pc_result pc;
    if (js_bootstrap(&db->js, &pc)) {
        snprintf(err, errlen, "bootstrap: %s", db->js.err);
        pc_result_free(&db->js, &pc);
        return -1;
    }
    if (pc.n == 0) {
        pc_result_free(&db->js, &pc);
        return 0;
    }
    for (size_t i = 0; i < pc.n; i++) {
        if (!stream_fills(&db->js, pc.items[i].stream)) {
            snprintf(err, errlen, "bootstrap: invalid stream name: %s", pc.items[i].stream);
            pc_result_free(&db->js, &pc);
            return -1;
        }
    }

    // one transaction, as a group commit would run it
    batch b = {0};
    b.servertime = now_ms();
    if (store_exec(db->w, "BEGIN IMMEDIATE")) die("begin: %s", store_err(db->w));
    char *reason = apply_outputs(db, &b, BOOTSTRAP_ID, &pc);
    if (reason) {
        if (store_exec(db->w, "ROLLBACK")) die("rollback: %s", store_err(db->w));
        snprintf(err, errlen, "bootstrap: %s", reason);
        free(reason);
        pldb_items_free(b.commit.v, b.commit.n);
        strlist_free(&b.written);
        strlist_free(&b.deleted);
        return -1;
    }
    if (store_command_insert(db->w, BOOTSTRAP_ID, db->position)) die("command_insert: %s", store_err(db->w));
    if (store_exec(db->w, "RELEASE cmd") || store_exec(db->w, "COMMIT")) die("commit: %s", store_err(db->w));

    // nothing is subscribed yet, so the commit's items go nowhere
    pldb_items_free(b.commit.v, b.commit.n);
    strlist_free(&b.written);
    strlist_free(&b.deleted);
    return 0;
}

int pldb_open(const char *dir, const char *bundle, pldb_hash_fn hasher, const char *const *env,
              int nenv, pldb **out, char *err, size_t errlen) {
    pldb *db = xmalloc(sizeof *db);
    memset(db, 0, sizeof *db);
    db->dir = xstrdup(dir);
    db->hasher = hasher;
    pthread_mutex_init(&db->rmu, NULL);
    pthread_mutex_init(&db->qmu, NULL);
    pthread_cond_init(&db->qcv, NULL);
    pthread_mutex_init(&db->resmu, NULL);
    pthread_cond_init(&db->rescv, NULL);
    if (mkdir(dir, 0755) && errno != EEXIST) {
        snprintf(err, errlen, "mkdir %s: %s", dir, strerror(errno));
        pldb_close(db);
        return -1;
    }
    char path[2048];
    snprintf(path, sizeof path, "%s/pldb.sqlite", dir);
    if (store_open(path, true, &db->w, err, errlen) || store_open(path, false, &db->r, err, errlen)) {
        pldb_close(db);
        return -1;
    }
    if (store_max_position(db->w, &db->position)) {
        snprintf(err, errlen, "%s", store_err(db->w));
        pldb_close(db);
        return -1;
    }
    if (js_open(&db->js, bundle, db->w, err, errlen)) {
        pldb_close(db);
        return -1;
    }
    if (load_epoch(dir, &db->epoch, err, errlen)) {
        pldb_close(db);
        return -1;
    }
    db->js.hasher = hasher;
    for (int i = 0; i < nenv; i++) strlist_push(&db->js.env_names, env[i]);
    if (db->position == 0 && run_bootstrap(db, err, errlen)) {
        pldb_close(db);
        return -1;
    }
    if (pthread_create(&db->thread, NULL, txn_loop, db)) {
        snprintf(err, errlen, "pthread_create failed");
        pldb_close(db);
        return -1;
    }
    db->started = true;
    *out = db;
    return 0;
}

void pldb_close(pldb *db) {
    if (!db) return;
    if (db->started) {
        pthread_mutex_lock(&db->qmu);
        db->stop = true;
        pthread_cond_signal(&db->qcv);
        pthread_mutex_unlock(&db->qmu);
        pthread_join(db->thread, NULL);
        results_push(db, result_new(PLDB_R_SHUTDOWN));
    }
    js_close(&db->js);
    free(db->epoch);
    while (db->regs) {
        reg *g = db->regs;
        db->regs = g->next;
        reg_free(g);
    }
    store_close(db->w);
    store_close(db->r);
    free(db->dir);
    free(db);
}

const char *pldb_epoch(pldb *db) { return db->epoch; }

// reader side //////////////////////////////////////////////////////////////

typedef struct read_ctx {
    items it;
} read_ctx;

static int read_cb(void *arg, uint64_t position, const char *stream, uint64_t seq,
                   const char *commandid, int64_t servertime, const uint8_t *data, size_t len) {
    read_ctx *rc = arg;
    item_set(items_push(&rc->it), position, stream, seq, commandid, servertime, data, len);
    return 0;
}

int pldb_read_log(pldb *db, uint64_t from, uint64_t to, pldb_item **items, size_t *n) {
    read_ctx rc = {0};
    pthread_mutex_lock(&db->rmu);
    int r = store_read_log(db->r, from, to, read_cb, &rc);
    pthread_mutex_unlock(&db->rmu);
    if (r) {
        pldb_items_free(rc.it.v, rc.it.n);
        return -1;
    }
    *items = rc.it.v;
    *n = rc.it.n;
    return 0;
}

int pldb_read_events(pldb *db, const char *ref, uint64_t from, uint64_t to, int reverse,
                     size_t limit, pldb_item **items, size_t *n) {
    read_ctx rc = {0};
    char prefix[1024];
    if (is_wildcard(ref)) ref_prefix(ref, prefix, sizeof prefix);
    pthread_mutex_lock(&db->rmu);
    int r = is_wildcard(ref)
                ? store_read_prefix(db->r, prefix, from, to, reverse != 0, limit, read_cb, &rc)
                : store_read_stream(db->r, ref, from, to, reverse != 0, limit, read_cb, &rc);
    pthread_mutex_unlock(&db->rmu);
    if (r) {
        pldb_items_free(rc.it.v, rc.it.n);
        return -1;
    }
    *items = rc.it.v;
    *n = rc.it.n;
    return 0;
}

typedef struct snap_ctx {
    buf records;
    uint32_t count;
} snap_ctx;

static int snap_cb(void *arg, const char *key, const uint8_t *val, size_t len) {
    snap_ctx *sc = arg;
    size_t klen = strlen(key);
    size_t start = sc->records.len;
    buf_u32(&sc->records, (uint32_t)klen);
    buf_append(&sc->records, key, klen);
    buf_u32(&sc->records, (uint32_t)len);
    buf_append(&sc->records, val, len);
    /* crc over key ‖ value, which are not contiguous in the buffer */
    uint8_t *k = sc->records.p + start + 4;
    uint8_t *tmp = xmalloc(klen + len);
    memcpy(tmp, k, klen);
    memcpy(tmp + klen, val, len);
    buf_u32(&sc->records, pl_crc32c(tmp, klen + len));
    free(tmp);
    sc->count++;
    return 0;
}

/* the header's streams map, written as it is read from the streams table */
static int snap_stream_cb(void *arg, const char *name, uint64_t seq) {
    mpack_writer_t *w = arg;
    mpack_write_cstr(w, name);
    mpack_write_u64(w, seq);
    return 0;
}

int pldb_snapshot(pldb *db, const char *ref, uint8_t **out, size_t *len, uint64_t *position) {
    char prefix[1024];
    if (is_wildcard(ref)) ref_prefix(ref, prefix, sizeof prefix);
    else snprintf(prefix, sizeof prefix, "%s/", ref);

    snap_ctx sc = {0};
    uint64_t seq = 0, event_bytes = 0, state_bytes = 0;
    int have_stats = 0, live = 0;
    char *hdr = NULL;
    size_t hsize = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &hdr, &hsize);

    pthread_mutex_lock(&db->rmu);
    int rc = store_exec(db->r, "BEGIN");
    if (!rc) rc = store_max_position(db->r, position);
    if (!rc) rc = store_scan(db->r, prefix, snap_cb, &sc);
    if (!rc && !is_wildcard(ref)) {
        have_stats = store_stream_stats(db->r, ref, &seq, &event_bytes, &state_bytes);
        if (have_stats < 0) rc = -1;
        if (!rc && (live = store_live_stream(db->r, ref, &seq)) < 0) rc = -1;
    }
    if (!rc) {
        mpack_start_map(&w, have_stats > 0 ? 7 : 5);
        mpack_write_cstr(&w, "ref");
        mpack_write_cstr(&w, ref);
        mpack_write_cstr(&w, "position");
        mpack_write_u64(&w, *position);
        mpack_write_cstr(&w, "fold");
        mpack_write_cstr(&w, db->epoch);
        mpack_write_cstr(&w, "count");
        mpack_write_u32(&w, sc.count);
        mpack_write_cstr(&w, "streams");
        if (is_wildcard(ref)) {
            mpack_build_map(&w);
            rc = store_live_streams(db->r, prefix, snap_stream_cb, &w);
            mpack_complete_map(&w);
        } else {
            mpack_start_map(&w, live ? 1 : 0);
            if (live) snap_stream_cb(&w, ref, seq);
            mpack_finish_map(&w);
        }
    }
    store_exec(db->r, "COMMIT");
    pthread_mutex_unlock(&db->rmu);
    if (rc) {
        mpack_writer_destroy(&w);
        free(hdr);
        buf_free(&sc.records);
        return -1;
    }

    if (have_stats > 0) {
        mpack_write_cstr(&w, "event_bytes");
        mpack_write_u64(&w, event_bytes);
        mpack_write_cstr(&w, "state_bytes");
        mpack_write_u64(&w, state_bytes);
    }
    mpack_finish_map(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) die("snapshot header");

    buf b = {0};
    buf_append(&b, "PLSN", 4);
    uint8_t version = 1;
    buf_append(&b, &version, 1);
    buf_u32(&b, (uint32_t)hsize);
    buf_append(&b, hdr, hsize);
    buf_u32(&b, pl_crc32c((const uint8_t *)hdr, hsize));
    free(hdr);
    buf_append(&b, sc.records.p, sc.records.len);
    buf_u32(&b, 0xFFFFFFFFu);
    uint8_t footer[12];
    footer[0] = sc.count >> 24;
    footer[1] = sc.count >> 16;
    footer[2] = sc.count >> 8;
    footer[3] = sc.count;
    uint64_t h = pl_fnv1a(sc.records.p, sc.records.len, 14695981039346656037ull);
    for (int i = 0; i < 8; i++) footer[4 + i] = (uint8_t)(h >> (56 - 8 * i));
    buf_append(&b, footer, 12);
    buf_u32(&b, pl_crc32c(footer, 12));
    buf_free(&sc.records);
    *out = b.p;
    *len = b.len;
    return 0;
}

// the command check //////////////////////////////////////////////////////

static char *reasonf(const char *fmt, ...) {
    char msg[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    return xstrdup(msg);
}

/* whether a parsed request element is [id, data, expect?] with a non-empty string id */
static bool is_command_pair(mpack_node_t pair) {
    if (mpack_node_type(pair) != mpack_type_array || mpack_node_array_length(pair) < 2) return false;
    mpack_node_t id = mpack_node_array_at(pair, 0);
    return mpack_node_type(id) == mpack_type_str && mpack_node_strlen(id) > 0;
}

/* Check one command's data and prepare its fields: a NewPassword is hashed; any other kind
   cannot be verified yet.  Writes the prepared [id, data, expect?] to out, or answers why the
   command is rejected; a hash function's refusal sets *refused instead, and answers NULL. */
static char *prepare_command(pldb *db, uintptr_t arg, mpack_node_t pair, buf *out, int *refused) {
    long commands = schema_commands(db->js.sc);
    if (commands < 0) return xstrdup("this database takes no commands");
    mpack_node_t data = mpack_node_array_at(pair, 1);
    char why[512];
    intake_list il = {0};
    char *reason = NULL;
    if (walk_check(db->js.sc, data, commands, true, &il, why, sizeof why)) {
        reason = xstrdup(why);
        goto done;
    }

    // each prepared field's result
    for (size_t k = 0; k < il.n; k++) {
        intake *in = &il.v[k];
        if (strcmp(in->kind, "NewPassword") != 0) {
            reason = reasonf("%s fields are not supported by this database yet", in->kind);
            goto done;
        }
        char hash[512];
        int rc = db->hasher ? db->hasher(arg, mpack_node_str(in->node), mpack_node_strlen(in->node),
                                         hash, sizeof hash)
                            : PLDB_HASH_FAILED;
        if (rc == PLDB_HASH_BUSY || rc == PLDB_HASH_LIMITED) {
            *refused = rc;
            goto done;
        }
        if (rc != PLDB_HASH_OK) {
            reason = xstrdup("password hashing failed");
            goto done;
        }
        in->result = xstrdup(hash);
    }

    // the command as checked, its prepared fields replaced
    char *bytes = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &bytes, &size);
    size_t n = mpack_node_array_length(pair) > 2 ? 3 : 2;
    mpack_node_t id = mpack_node_array_at(pair, 0);
    mpack_start_array(&w, (uint32_t)n);
    mpack_write_str(&w, mpack_node_str(id), (uint32_t)mpack_node_strlen(id));
    int rc = walk_write(db->js.sc, data, commands, true, &il, &w, why, sizeof why);
    if (rc == 0 && n > 2) {
        rc = walk_write(db->js.sc, mpack_node_array_at(pair, 2), -1, false, NULL, &w, why, sizeof why);
        if (rc) snprintf(why, sizeof why, "malformed expect");
    }
    mpack_finish_array(&w);
    if (mpack_writer_destroy(&w) != mpack_ok && rc == 0) {
        snprintf(why, sizeof why, "encode failed");
        rc = -1;
    }
    if (rc) reason = xstrdup(why);
    else buf_append(out, bytes, size);
    free(bytes);

done:
    intake_list_free(&il);
    return reason;
}

int pldb_prepare(pldb *db, uintptr_t arg, const uint8_t *body, size_t len, pldb_prepared *out,
                 char *err, size_t errlen) {
    memset(out, 0, sizeof *out);
    mpack_tree_t tree;

    // the request is a sequence of [id, data, expect?] values: count them, refusing the whole
    // request when any is not one, since nothing can be answered for it
    size_t ncmds = 0;
    mpack_tree_init_data(&tree, (const char *)body, len);
    for (size_t consumed = 0; consumed < len; ncmds++) {
        mpack_tree_parse(&tree);
        if (mpack_tree_error(&tree) != mpack_ok) {
            snprintf(err, errlen, "malformed msgpack");
            mpack_tree_destroy(&tree);
            return -1;
        }
        consumed += mpack_tree_size(&tree);
        if (!is_command_pair(mpack_tree_root(&tree))) {
            snprintf(err, errlen, "command must be [id, data] with a string id");
            mpack_tree_destroy(&tree);
            return -1;
        }
    }
    mpack_tree_destroy(&tree);
    out->reasons = xmalloc(sizeof(char *) * (ncmds ? ncmds : 1));
    memset(out->reasons, 0, sizeof(char *) * (ncmds ? ncmds : 1));
    out->n = ncmds;

    // check and prepare each command; a refused hash refuses the request
    buf prepared = {0};
    int refused = 0;
    mpack_tree_init_data(&tree, (const char *)body, len);
    for (size_t i = 0; i < ncmds && !refused; i++) {
        mpack_tree_parse(&tree);
        out->reasons[i] = prepare_command(db, arg, mpack_tree_root(&tree), &prepared, &refused);
    }
    mpack_tree_destroy(&tree);
    out->body = prepared.p;
    out->len = prepared.len;
    if (refused) {
        pldb_prepared_free(out);
        snprintf(err, errlen, "password hashing refused");
        return refused;
    }
    return 0;
}

void pldb_prepared_free(pldb_prepared *p) {
    for (size_t i = 0; i < p->n; i++) free(p->reasons[i]);
    free(p->reasons);
    free(p->body);
    memset(p, 0, sizeof *p);
}
