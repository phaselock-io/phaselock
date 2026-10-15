/* The core: request and result queues, the txn loop, maySee registrations,
   and the reader-side calls. */

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>

#include "internal.h"
#include "sha256.h"

enum { REQ_SUBMIT = 1, REQ_REGISTER, REQ_UNREGISTER, REQ_LOOKUP, REQ_ARM, REQ_TICK, REQ_KEY };

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
    int64_t gen;
    uint8_t *body;
    size_t len;
    size_t entry; /* a tick's cron entry */
    int64_t slot; /* a tick's slot, or an arm's minute */
    /* a submit's verdicts, one per command of its body or none, and how often it has bounced */
    pldb_verdict *verdicts;
    size_t nverdicts;
    int attempt;
    /* a token key to add, its public key in body, and the ids of the keys it sweeps */
    char *kid;
    int64_t minted;
    strlist sweep;
    struct req *next;
} req;

/* one registered maySee query, shared by every connection with the same
   principal */
typedef struct reg {
    char *canon;
    char *user;
    strlist prefixes;
    char hash[17]; /* of prefixes, so a change to the set is one comparison */
    strlist rkeys;   /* the keys maySee got */
    span_list spans; /* what each of maySee's scan batches walked */
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

    pldb_cron_entry *cron;
    char **cron_keys; /* each entry's series key, $cron:<install>,<entry> */
    size_t ncron;
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
        free(items[i].data);
    }
    free(items);
}

void pldb_free(void *p) { free(p); }

/* encode [ [position, stream, seq, commandid, servertime], data ] */
static void encode_wire(buf *out, uint64_t position, const char *stream, uint64_t seq,
                        const uint8_t *commandid, int64_t servertime, const uint8_t *data,
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
    mpack_write_bin(&w, (const char *)commandid, ID_LEN);
    mpack_write_timestamp(&w, servertime / 1000, (uint32_t)(servertime % 1000) * 1000000u);
    mpack_finish_array(&w);
    mpack_write_object_bytes(&w, (const char *)data, len);
    mpack_finish_array(&w);
    if (mpack_writer_destroy(&w) != mpack_ok) die("encode_wire");
    buf_append(out, d, size);
    free(d);
}

static void item_set(pldb_item *it, uint64_t position, uint64_t atom, const char *stream,
                     uint64_t seq, const uint8_t *commandid, int64_t servertime,
                     const uint8_t *data, size_t len) {
    it->stream = xstrdup(stream);
    it->atom = atom;
    it->position = position;
    buf b = {0};
    encode_wire(&b, position, stream, seq, commandid, servertime, data, len);
    it->data = b.p;
    it->len = b.len;
}

/* a command id written as a uuid, for the server's log */
static void format_id(const uint8_t *id, char out[37]) {
    char *p = out;
    for (int i = 0; i < ID_LEN; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) *p++ = '-';
        p += snprintf(p, 3, "%02x", id[i]);
    }
}

/* What a client is told of a failure that is a bug, as opposed to a rejection: the whole error
   when the bundle is a dev build, and "internal error" otherwise.  The whole error goes to the
   log either way, under the command it failed when it failed one.  Takes msg. */
static char *bug_reason(const pldb *db, const uint8_t *id, char *msg) {
    if (id) {
        char uuid[37];
        format_id(id, uuid);
        fprintf(stderr, "pldb: command %s: %s\n", uuid, msg);
    } else {
        fprintf(stderr, "pldb: %s\n", msg);
    }
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
    free(r->marks);
    free(r->errmsg);
    free(r->hash);
    free(r);
}

static char **strings_copy(const strlist *l) {
    char **v = xmalloc(sizeof(char *) * (l->n ? l->n : 1));
    for (size_t i = 0; i < l->n; i++) v[i] = xstrdup(l->v[i]);
    return v;
}

// requests /////////////////////////////////////////////////////////////////

static req *req_new(int kind, uint64_t reqid, const char *user, int64_t gen) {
    req *q = xmalloc(sizeof *q);
    memset(q, 0, sizeof *q);
    q->kind = kind;
    q->reqid = reqid;
    q->user = user ? xstrdup(user) : NULL;
    q->gen = gen;
    return q;
}

static void req_free(req *q) {
    free(q->user);
    free(q->body);
    for (size_t i = 0; i < q->nverdicts; i++) free((char *)q->verdicts[i].hash);
    free(q->verdicts);
    free(q->kid);
    strlist_free(&q->sweep);
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

int pldb_submit(pldb *db, uint64_t reqid, const char *user, int64_t gen, const uint8_t *body,
                size_t len, const pldb_verdict *verdicts, size_t nverdicts, int attempt) {
    req *q = req_new(REQ_SUBMIT, reqid, user, gen);
    q->body = xmalloc(len);
    memcpy(q->body, body, len);
    q->len = len;
    if (nverdicts) {
        q->verdicts = xmalloc(sizeof *q->verdicts * nverdicts);
        for (size_t i = 0; i < nverdicts; i++) {
            q->verdicts[i].state = verdicts[i].state;
            q->verdicts[i].hash = verdicts[i].hash ? xstrdup(verdicts[i].hash) : NULL;
        }
        q->nverdicts = nverdicts;
    }
    q->attempt = attempt;
    enqueue(db, q);
    return 0;
}

int pldb_register(pldb *db, uint64_t reqid, uint64_t conn, const char *user, int64_t gen) {
    req *q = req_new(REQ_REGISTER, reqid, user, gen);
    q->conn = conn;
    enqueue(db, q);
    return 0;
}

int pldb_unregister(pldb *db, uint64_t conn) {
    req *q = req_new(REQ_UNREGISTER, 0, NULL, -1);
    q->conn = conn;
    enqueue(db, q);
    return 0;
}

int pldb_lookup(pldb *db, uint64_t reqid, const uint8_t *ident, size_t len) {
    req *q = req_new(REQ_LOOKUP, reqid, NULL, -1);
    q->body = xmalloc(len);
    memcpy(q->body, ident, len);
    q->len = len;
    enqueue(db, q);
    return 0;
}

size_t pldb_cron_entries(pldb *db, const pldb_cron_entry **out) {
    *out = db->cron;
    return db->ncron;
}

int pldb_cron_arm(pldb *db, uint64_t reqid, int64_t minute) {
    if (minute <= 0) return -1;
    req *q = req_new(REQ_ARM, reqid, NULL, -1);
    q->slot = minute;
    enqueue(db, q);
    return 0;
}

int pldb_key_add(pldb *db, uint64_t reqid, const pldb_key *key, const char *const *sweep,
                 size_t nsweep) {
    req *q = req_new(REQ_KEY, reqid, NULL, -1);
    q->kid = xstrdup(key->kid);
    q->body = xmalloc(key->len ? key->len : 1);
    memcpy(q->body, key->pub, key->len);
    q->len = key->len;
    q->minted = key->minted;
    for (size_t i = 0; i < nsweep; i++) strlist_push(&q->sweep, sweep[i]);
    enqueue(db, q);
    return 0;
}

int pldb_cron_tick(pldb *db, uint64_t reqid, size_t i, int64_t slot) {
    if (i >= db->ncron || slot <= 0) return -1;
    req *q = req_new(REQ_TICK, reqid, NULL, -1);
    q->entry = i;
    q->slot = slot;
    enqueue(db, q);
    return 0;
}

// maySee registrations /////////////////////////////////////////////////////

static char *canon_principal(const char *user) {
    return user ? strf("u:%s", user) : xstrdup("anon");
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
    JSValue principal = js_principal(&db->js, g->user);
    strlist_clear(&g->prefixes);
    strlist_clear(&g->rkeys);
    span_list_clear(&g->spans);
    db->js.track_rkeys = &g->rkeys;
    db->js.track_spans = &g->spans;
    int rc = js_maysee(&db->js, principal, &g->prefixes);
    db->js.track_rkeys = NULL;
    db->js.track_spans = NULL;
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
    strlist_free(&g->prefixes);
    strlist_free(&g->rkeys);
    span_list_free(&g->spans);
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

/* A wire ref is a stream name, a wildcard "chat:*" or "chat:acme,*" for
   every stream whose name begins with its text before the star, or "*"
   for every stream.  Wildcards are the prefix they cover, "" for "*". */
static bool is_wildcard(const char *ref) {
    size_t n = strlen(ref);
    if (n == 1) return ref[0] == '*';
    return n > 2 && ref[n - 1] == '*' && (ref[n - 2] == ':' || ref[n - 2] == ',');
}

static void ref_prefix(const char *ref, char *out, size_t cap) {
    size_t n = strlen(ref) - 1; /* drop the star */
    if (n + 1 > cap) n = cap - 1;
    memcpy(out, ref, n);
    out[n] = 0;
}

/* maySee returns refs with a terminator on every entry: a wildcard
   ("chat:*", "chat:acme,*", "*") or "name!" for an exact stream, so a bare
   name is never a grant.  Strips the '!' into wire form; false on a
   malformed entry, one whose name does not fill its family's template, or
   a wildcard that cuts into a parameter. */
static bool normalize_bundle_ref(const jsrt *js, char *ref) {
    size_t n = strlen(ref);
    if (strcmp(ref, "*") == 0) return true;
    if (n > 1 && ref[n - 1] == '!') {
        ref[n - 1] = 0;
        return stream_fills(js, ref);
    }
    if (!is_wildcard(ref)) return false;
    ref[n - 1] = 0; /* the text before the star */
    bool ok = ref_prefix_fills(js, ref);
    ref[n - 1] = '*';
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
static int check_generation(pldb *db, const char *user, int64_t gen) {
    if (!user || gen < 0) return 0;
    JSValue principal = js_principal(&db->js, user);
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
    if (check_generation(db, q->user, q->gen)) {
        r = result_new(PLDB_R_VIEW);
        r->status = 401;
        r->conn = q->conn;
        r->reqid = q->reqid;
        (*after_tail)->next = r;
        *after_tail = r;
        return;
    }
    char *canon = canon_principal(q->user);
    reg *g = reg_find(db, canon);
    if (!g) {
        g = xmalloc(sizeof *g);
        memset(g, 0, sizeof *g);
        g->canon = canon;
        g->user = q->user ? xstrdup(q->user) : NULL;
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

/* Whether a batch's writes touched what a registration's maySee read: a written key it got or
   one inside a stretch a scan batch walked, or a deleted prefix holding a key it got or one that
   could lie inside such a stretch.  A spurious re-run costs only time, so a deleted prefix
   dirties whenever it may. */
static bool reads_touched(const reg *g, const strlist *written, const strlist *deleted) {
    // the written keys
    for (size_t i = 0; i < written->n; i++) {
        const char *k = written->v[i];
        if (strlist_has(&g->rkeys, k)) return true;
        size_t n = strlen(k);
        for (size_t j = 0; j < g->spans.n; j++) {
            if (span_covers(&g->spans.v[j], k, n)) return true;
        }
    }

    // the deleted prefixes
    for (size_t i = 0; i < deleted->n; i++) {
        const char *p = deleted->v[i];
        for (size_t j = 0; j < g->rkeys.n; j++) {
            if (has_prefix(g->rkeys.v[j], p)) return true;
        }
        size_t n = strlen(p);
        for (size_t j = 0; j < g->spans.n; j++) {
            if (span_may_hold(&g->spans.v[j], p, n)) return true;
        }
    }
    return false;
}

/* after a batch's writes: re-run every maySee whose read-set was touched,
   and emit a view result to every connection of a registration whose
   prefixes changed */
static void invalidate_views(pldb *db, const strlist *written, const strlist *deleted,
                             pldb_result **head, pldb_result **tail) {
    for (reg *g = db->regs; g; g = g->next) {
        if (!reads_touched(g, written, deleted)) continue;
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
static void append_event(pldb *db, batch *b, uint64_t atom, const char *stream,
                         const uint8_t *commandid, const uint8_t *data, size_t len) {
    uint64_t pos = ++db->position;
    uint64_t seq;
    if (store_stream_next_seq(db->w, stream, len, &seq)) die("next_seq: %s", store_err(db->w));
    if (store_append(db->w, pos, atom, stream, seq, commandid, b->servertime, data, len))
        die("append: %s", store_err(db->w));
    item_set(items_push(&b->commit), pos, atom, stream, seq, commandid, b->servertime, data, len);
}

static void family_of(const char *stream, char *out, size_t cap) {
    const char *colon = strchr(stream, ':');
    size_t n = colon ? (size_t)(colon - stream) : strlen(stream);
    if (n >= cap) n = cap - 1;
    memcpy(out, stream, n);
    out[n] = 0;
}

/* the most streams one command's expectations may name */
#define EXPECT_MAX 1024

/* one command: returns the outcome as an mpack write into w */
/* The OCC check: every expected stream's seq must be exactly what the client names (0 for never
   born).  expect is the command's map as the intake checked it, or NULL for a command without
   one.  Writes a conflict outcome listing each mismatched stream's actual seq and returns true
   when any differs. */
static bool check_expect(pldb *db, mpack_writer_t *w, const mpack_node_t *expect) {
    if (!expect) return false;
    size_t n = mpack_node_map_count(*expect);
    if (n > EXPECT_MAX) die("prepared expect: %zu streams", n);

    // the streams whose seq differs from what the client named, with their seq
    struct conflict {
        mpack_node_t name;
        uint64_t seq;
    } conflicts[EXPECT_MAX];
    size_t nconflicts = 0;
    buf name = {0};
    for (size_t i = 0; i < n; i++) {
        mpack_node_t k = mpack_node_map_key_at(*expect, i);
        name.len = 0;
        buf_append(&name, mpack_node_str(k), mpack_node_strlen(k));
        buf_append(&name, "", 1);
        uint64_t seq = 0, eb, sb;
        int rc = store_stream_stats(db->w, (const char *)name.p, &seq, &eb, &sb);
        if (rc < 0) die("stream_stats: %s", store_err(db->w));
        uint64_t want = mpack_node_u64(mpack_node_map_value_at(*expect, i));
        if (seq != want) conflicts[nconflicts++] = (struct conflict){k, seq};
    }
    buf_free(&name);
    if (nconflicts == 0) return false;
    mpack_start_array(w, 2);
    mpack_write_cstr(w, "conflict");
    mpack_start_map(w, (uint32_t)nconflicts);
    for (size_t i = 0; i < nconflicts; i++) {
        mpack_node_t k = conflicts[i].name;
        mpack_write_str(w, mpack_node_str(k), (uint32_t)mpack_node_strlen(k));
        mpack_write_u64(w, conflicts[i].seq);
    }
    mpack_finish_map(w);
    mpack_finish_array(w);
    return true;
}

/* Append a command's outputs as one atom and fold them, inside a savepoint named cmd that the
   caller releases on success.  Births come before a born stream's first event, deaths clear the
   stream's keys, an erasure its earlier events too, and each stream's events reach its family's
   reducer as one run.  Frees pc.
   Answers NULL, or why the atom was rolled back. */
static char *apply_outputs(pldb *db, batch *b, const uint8_t *id, pc_result *pc) {
    JSContext *ctx = db->js.ctx;
    char *reason = NULL;
    uint64_t start = db->position, atom = start + 1;
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
            append_event(db, b, atom, it->stream, id, DEATH, sizeof DEATH);
            if (store_stream_death(db->w, it->stream, db->position)) die("death: %s", store_err(db->w));
            if (it->erase && store_stream_erase(db->w, it->stream, db->position)) {
                die("erase: %s", store_err(db->w));
            }
            char prefix[1024];
            snprintf(prefix, sizeof prefix, "%s!", it->stream);
            if (store_del_prefix(db->w, prefix)) die("del_prefix: %s", store_err(db->w));
            strlist_push(&b->deleted, prefix);
            continue;
        }
        if (!live) {
            if (store_stream_birth(db->w, it->stream, db->position + 1)) die("birth: %s", store_err(db->w));
            append_event(db, b, atom, it->stream, id, BIRTH, sizeof BIRTH);
        }
        append_event(db, b, atom, it->stream, id, it->bytes.p, it->bytes.len);
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
            free(b->commit.v[i].data);
        }
        b->commit.n = commit_start;
        while (b->written.n > written_start) free(b->written.v[--b->written.n]);
        while (b->deleted.n > deleted_start) free(b->deleted.v[--b->deleted.n]);
        return reason;
    }
    return NULL;
}

/* write an outcome of a kind and a reason */
static void write_reason(mpack_writer_t *w, const char *kind, const char *reason) {
    mpack_start_array(w, 2);
    mpack_write_cstr(w, kind);
    mpack_write_cstr(w, reason);
    mpack_finish_array(w);
}

/* write an ok outcome: the command was decided at or before position */
static void write_ok(mpack_writer_t *w, uint64_t position) {
    mpack_start_array(w, 2);
    mpack_write_cstr(w, "ok");
    mpack_write_u64(w, position);
    mpack_finish_array(w);
}

/* Decide one command: expect, precommit, and the append and fold of what precommit emitted.  A
   reject or a conflict leaves nothing in the log or the store. */
static void decide(pldb *db, batch *b, mpack_writer_t *w, const uint8_t *id, JSValueConst data,
                   const mpack_node_t *expect, JSValueConst principal) {
    // the client's expectations of its streams
    if (check_expect(db, w, expect)) return;

    // precommit, and the streams it emitted to
    char *reason = NULL;
    pc_result pc = {0};
    if (js_precommit(&db->js, data, principal, &pc)) {
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
        write_reason(w, "reject", reason);
        free(reason);
        return;
    }

    // the atom, answered ok at the head after it
    reason = apply_outputs(db, b, id, &pc);
    if (reason) {
        write_reason(w, "reject", reason);
        free(reason);
        return;
    }
    if (store_exec(db->w, "RELEASE cmd")) die("release: %s", store_err(db->w));
    write_ok(w, db->position);
}

enum { PROOF_HOLDS, PROOF_DECIDED, PROOF_BOUNCED };

/* A proven command's proof, against what lookup answers for its sender now, which is what
   precommit would read: PROOF_HOLDS when it passed against the same hash; PROOF_DECIDED with a
   rejection written into w when it failed against the same hash, or lookup failed; and
   PROOF_BOUNCED with the hash lookup answers in *bounce when the hash changed after the proof
   was checked, so that the proof is checked again against it.  A call that has bounced
   PLDB_MAX_BOUNCES times is decided instead, since a hash that changes on every read is lookup's
   bug. */
static int check_proof(pldb *db, mpack_writer_t *w, const uint8_t *id, const pldb_verdict *v,
                       int attempt, JSValueConst principal, char **bounce) {
    char *now = NULL;
    if (js_password_hash(&db->js, principal, &now)) {
        char *reason = bug_reason(db, id, strf("lookup error: %s", db->js.err));
        write_reason(w, "reject", reason);
        free(reason);
        return PROOF_DECIDED;
    }

    // has the hash changed since the proof was checked?
    bool same = now && v->hash ? strcmp(now, v->hash) == 0 : now == v->hash;
    if (!same && attempt < PLDB_MAX_BOUNCES) {
        *bounce = now;
        return PROOF_BOUNCED;
    }
    free(now);
    if (!same) {
        char *reason = bug_reason(db, id, strf("lookup answered a different passwordHash on each "
                                               "of %d reads", PLDB_MAX_BOUNCES + 2));
        write_reason(w, "reject", reason);
        free(reason);
        return PROOF_DECIDED;
    }

    // with the credentials unchanged, a failed verdict stands
    if (v->state == PLDB_PROOF_FAILED) {
        write_reason(w, "reject", "invalid credentials");
        return PROOF_DECIDED;
    }
    return PROOF_HOLDS;
}

/* One command, its outcome written into w.  A command in a series passes the dedup check first,
   against the group's open transaction, so it sees every decision ahead of it in its group: a
   number at or below the series' mark was decided already, and anything else runs, an unknown
   series included, since series rows are kept forever.  A proven command's proof is checked
   next, before its expectations, so a failed proof never learns a stream's seq.  Every decision
   moves the mark, whatever it decided.  Answers whether the command bounced instead, which
   decides nothing and writes no outcome, with what lookup answers in *bounce. */
static bool run_command(pldb *db, batch *b, mpack_writer_t *w, const char *series, uint64_t n,
                        const uint8_t *id, JSValueConst data, const mpack_node_t *expect,
                        JSValueConst principal, const pldb_verdict *v, int attempt,
                        char **bounce) {
    // the dedup check
    if (series) {
        uint64_t hwm = 0;
        int known = store_series_hwm(db->w, series, &hwm);
        if (known < 0) die("series_hwm: %s", store_err(db->w));
        if (known && n <= hwm) {
            write_ok(w, db->position);
            return false;
        }
    }

    // the proof, then the command
    int proof = v && v->state != PLDB_PROOF_NONE
                    ? check_proof(db, w, id, v, attempt, principal, bounce)
                    : PROOF_HOLDS;
    if (proof == PROOF_BOUNCED) return true;
    if (proof == PROOF_HOLDS) decide(db, b, w, id, data, expect, principal);

    // the decision moves the mark; a rolled-back atom has already left its savepoint
    if (series && store_series_mark(db->w, series, n, b->servertime))
        die("series_mark: %s", store_err(db->w));
    return false;
}

static void handle_submit(pldb *db, batch *b, req *q, pldb_result **after_tail) {
    pldb_result *r = result_new(PLDB_R_OUTCOME);
    r->reqid = q->reqid;
    (*after_tail)->next = r;
    *after_tail = r;
    if (check_generation(db, q->user, q->gen)) {
        r->status = 401;
        return;
    }
    JSContext *ctx = db->js.ctx;
    JSValue principal = js_principal(&db->js, q->user);

    char *data = NULL;
    size_t size = 0;
    mpack_writer_t w;
    mpack_writer_init_growable(&w, &data, &size);
    mpack_build_array(&w);

    /* walk the prepared [key, n, id, data, expect?] values, each already checked, with a
       series' key or nil in place of the series, until one bounces */
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)q->body, q->len);
    long commands = schema_commands(db->js.sc);
    char why[512];
    size_t k = 0;
    for (size_t consumed = 0; consumed < q->len && !r->bounce; k++) {
        mpack_tree_parse(&tree);
        if (mpack_tree_error(&tree) != mpack_ok) die("prepared body: malformed msgpack");
        consumed += mpack_tree_size(&tree);
        mpack_node_t c = mpack_tree_root(&tree);

        // the series' key and the command's number, or none for an unnumbered command
        mpack_node_t keyn = mpack_node_array_at(c, 0);
        char *key = NULL;
        uint64_t n = 0;
        if (mpack_node_type(keyn) != mpack_type_nil) {
            key = xmalloc(mpack_node_strlen(keyn) + 1);
            memcpy(key, mpack_node_str(keyn), mpack_node_strlen(keyn));
            key[mpack_node_strlen(keyn)] = 0;
            n = mpack_node_u64(mpack_node_array_at(c, 1));
        }
        const uint8_t *id = (const uint8_t *)mpack_node_bin_data(mpack_node_array_at(c, 2));

        // the data as a JS value, and the expectations
        JSValue datav = walk_prepared_to_js(ctx, db->js.sc, mpack_node_array_at(c, 3), commands,
                                            why, sizeof why);
        mpack_node_t expect;
        bool expects = mpack_node_array_length(c) > 4;
        if (expects) expect = mpack_node_array_at(c, 4);
        if (JS_IsException(datav)) {
            if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
            write_reason(&w, "reject", why);
        } else {
            const pldb_verdict *v = k < q->nverdicts ? &q->verdicts[k] : NULL;
            r->bounce = run_command(db, b, &w, key, n, id, datav, expects ? &expect : NULL,
                                    principal, v, q->attempt, &r->hash);
        }
        free(key);
        JS_FreeValue(ctx, datav);
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

/* Give every cron entry without a mark the request's minute, so that it first fires at its
   first slot after that, and answer every entry's mark. */
static void handle_arm(pldb *db, batch *b, req *q, pldb_result **after_tail) {
    pldb_result *r = result_new(PLDB_R_ARM);
    r->reqid = q->reqid;
    r->marks = xmalloc(sizeof(int64_t) * (db->ncron ? db->ncron : 1));
    r->nmarks = db->ncron;
    for (size_t i = 0; i < db->ncron; i++) {
        uint64_t mark = 0;
        int known = store_series_hwm(db->w, db->cron_keys[i], &mark);
        if (known < 0) die("series_hwm: %s", store_err(db->w));
        if (!known) {
            mark = (uint64_t)q->slot;
            if (store_series_mark(db->w, db->cron_keys[i], mark, b->servertime))
                die("series_mark: %s", store_err(db->w));
        }
        r->marks[i] = (int64_t)mark;
    }
    (*after_tail)->next = r;
    *after_tail = r;
}

/* One tick of a cron entry, past intake.  A slot at or below the entry's mark was decided
   already; any other runs the entry's hook as its install's command, with the batch's server
   time as the tick's now, and lands what it emitted as one atom under a label of its own.  The
   decision moves the mark, a hook's failure included. */
static void handle_tick(pldb *db, batch *b, req *q, pldb_result **after_tail) {
    pldb_result *r = result_new(PLDB_R_TICK);
    r->reqid = q->reqid;
    (*after_tail)->next = r;
    *after_tail = r;
    const pldb_cron_entry *e = &db->cron[q->entry];
    const char *key = db->cron_keys[q->entry];

    // the dedup check
    uint64_t mark = 0;
    int known = store_series_hwm(db->w, key, &mark);
    if (known < 0) die("series_hwm: %s", store_err(db->w));
    if (known && (uint64_t)q->slot <= mark) return;

    // the hook, and the streams it emitted to
    uint8_t id[ID_LEN];
    if (os_random(id, sizeof id)) die("random bytes: %s", strerror(errno));
    char *reason = NULL;
    pc_result pc;
    if (js_tick(&db->js, e->install, e->entry, q->slot * 1000, b->servertime, &pc)) {
        reason = bug_reason(db, id, strf("cron %s,%s: %s", e->install, e->entry, db->js.err));
    }
    for (size_t i = 0; i < pc.n && !reason; i++)
        if (!stream_fills(&db->js, pc.items[i].stream)) {
            reason = bug_reason(db, id, strf("invalid stream name: %s", pc.items[i].stream));
        }

    // the atom
    if (reason) {
        pc_result_free(&db->js, &pc);
    } else {
        reason = apply_outputs(db, b, id, &pc);
        if (!reason && store_exec(db->w, "RELEASE cmd")) die("release: %s", store_err(db->w));
    }
    if (reason) {
        r->status = 500;
        r->errmsg = reason;
    }

    // the decision moves the mark
    if (store_series_mark(db->w, key, (uint64_t)q->slot, b->servertime))
        die("series_mark: %s", store_err(db->w));
}

/* add a token key and delete the keys it sweeps, answered once the batch commits */
static void handle_key(pldb *db, req *q, pldb_result **after_tail) {
    if (store_key_add(db->w, q->kid, q->body, q->len, q->minted)) {
        die("key_add: %s", store_err(db->w));
    }
    for (size_t i = 0; i < q->sweep.n; i++) {
        if (store_key_del(db->w, q->sweep.v[i])) die("key_del: %s", store_err(db->w));
    }
    pldb_result *r = result_new(PLDB_R_KEY);
    r->reqid = q->reqid;
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
        case REQ_ARM:
            handle_arm(db, &b, q, &after_tail);
            break;
        case REQ_TICK:
            handle_tick(db, &b, q, &after_tail);
            break;
        case REQ_KEY:
            handle_key(db, q, &after_tail);
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
    if (os_random(raw, sizeof raw)) {
        snprintf(err, errlen, "random bytes: %s", strerror(errno));
        return -1;
    }
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

    // the atom's id, a label like any client's
    uint8_t id[ID_LEN];
    if (os_random(id, sizeof id)) {
        snprintf(err, errlen, "random bytes: %s", strerror(errno));
        pc_result_free(&db->js, &pc);
        return -1;
    }

    // one transaction, as a group commit would run it
    batch b = {0};
    b.servertime = now_ms();
    if (store_exec(db->w, "BEGIN IMMEDIATE")) die("begin: %s", store_err(db->w));
    char *reason = apply_outputs(db, &b, id, &pc);
    if (reason) {
        if (store_exec(db->w, "ROLLBACK")) die("rollback: %s", store_err(db->w));
        snprintf(err, errlen, "bootstrap: %s", reason);
        free(reason);
        pldb_items_free(b.commit.v, b.commit.n);
        strlist_free(&b.written);
        strlist_free(&b.deleted);
        return -1;
    }
    if (store_exec(db->w, "RELEASE cmd") || store_exec(db->w, "COMMIT")) die("commit: %s", store_err(db->w));

    // nothing is subscribed yet, so the commit's items go nowhere
    pldb_items_free(b.commit.v, b.commit.n);
    strlist_free(&b.written);
    strlist_free(&b.deleted);
    return 0;
}

/* whether an entry's name is 1 to 64 bytes of [A-Za-z0-9_-] */
static bool cron_name(const char *s) {
    size_t n = strlen(s);
    if (n == 0 || n > 64) return false;
    for (size_t i = 0; i < n; i++)
        if (!isalnum((unsigned char)s[i]) && s[i] != '_' && s[i] != '-') return false;
    return true;
}

/* Read the bundle's cron entries, each with the series key that holds its mark.  An install's
   name is a JS identifier without $, which the bundle's plugin set checks, and an entry's name
   must be fit for the key too. */
static int load_cron(pldb *db, char *err, size_t errlen) {
    strlist l = {0};
    if (js_cron_entries(&db->js, &l)) {
        snprintf(err, errlen, "cron entries: %s", db->js.err);
        strlist_free(&l);
        return -1;
    }
    for (size_t i = 0; i + 2 < l.n; i += 3)
        if (!cron_name(l.v[i + 1])) {
            snprintf(err, errlen, "cron entry %s of %s: not 1 to 64 of [A-Za-z0-9_-]", l.v[i + 1],
                     l.v[i]);
            strlist_free(&l);
            return -1;
        }
    db->ncron = l.n / 3;
    db->cron = xmalloc(sizeof(pldb_cron_entry) * (db->ncron ? db->ncron : 1));
    db->cron_keys = xmalloc(sizeof(char *) * (db->ncron ? db->ncron : 1));
    for (size_t i = 0; i < db->ncron; i++) {
        const char *install = l.v[3 * i], *entry = l.v[3 * i + 1], *spec = l.v[3 * i + 2];
        db->cron[i] = (pldb_cron_entry){xstrdup(install), xstrdup(entry), xstrdup(spec)};
        db->cron_keys[i] = strf("$cron:%s,%s", install, entry);
    }
    strlist_free(&l);
    return 0;
}

int pldb_open(const char *dir, const char *host, size_t hostlen, const char *bundle,
              pldb_hash_fn hasher, const char *const *env, int nenv, pldb **out, char *err,
              size_t errlen) {
    pldb *db = xmalloc(sizeof *db);
    memset(db, 0, sizeof *db);
    db->dir = xstrdup(dir);
    db->hasher = hasher;
    pthread_mutex_init(&db->rmu, NULL);
    pthread_mutex_init(&db->qmu, NULL);
    pthread_cond_init(&db->qcv, NULL);
    pthread_mutex_init(&db->resmu, NULL);
    pthread_cond_init(&db->rescv, NULL);
    if (os_mkdir(dir)) {
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
    if (js_open(&db->js, host, hostlen, bundle, db->w, err, errlen)) {
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
    if (load_cron(db, err, errlen)) {
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
    for (size_t i = 0; i < db->ncron; i++) {
        free((char *)db->cron[i].install);
        free((char *)db->cron[i].entry);
        free((char *)db->cron[i].spec);
        free(db->cron_keys[i]);
    }
    free(db->cron);
    free(db->cron_keys);
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

static int read_cb(void *arg, uint64_t position, uint64_t atom, const char *stream, uint64_t seq,
                   const uint8_t *commandid, int64_t servertime, const uint8_t *data, size_t len) {
    read_ctx *rc = arg;
    item_set(items_push(&rc->it), position, atom, stream, seq, commandid, servertime, data, len);
    return 0;
}

typedef struct key_list {
    pldb_key *v;
    size_t n, cap;
} key_list;

static int key_cb(void *arg, const char *kid, const uint8_t *pub, size_t len, int64_t minted) {
    key_list *l = arg;
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 8;
        l->v = realloc(l->v, l->cap * sizeof *l->v);
        if (!l->v) die("out of memory");
    }
    pldb_key *k = &l->v[l->n++];
    k->kid = xstrdup(kid);
    k->pub = xmalloc(len ? len : 1);
    memcpy(k->pub, pub, len);
    k->len = len;
    k->minted = minted;
    return 0;
}

int pldb_keys(pldb *db, pldb_key **out, size_t *n) {
    key_list l = {0};
    pthread_mutex_lock(&db->rmu);
    int rc = store_keys(db->r, key_cb, &l);
    pthread_mutex_unlock(&db->rmu);
    if (rc) {
        pldb_keys_free(l.v, l.n);
        return -1;
    }
    *out = l.v;
    *n = l.n;
    return 0;
}

void pldb_keys_free(pldb_key *keys, size_t n) {
    for (size_t i = 0; i < n; i++) {
        free(keys[i].kid);
        free(keys[i].pub);
    }
    free(keys);
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
    else snprintf(prefix, sizeof prefix, "%s!", ref);

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
        mpack_start_map(&w, have_stats > 0 ? 6 : 4);
        mpack_write_cstr(&w, "ref");
        mpack_write_cstr(&w, ref);
        mpack_write_cstr(&w, "position");
        mpack_write_u64(&w, *position);
        mpack_write_cstr(&w, "fold");
        mpack_write_cstr(&w, db->epoch);
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

/* the longest series id a command may carry, in bytes */
#define SERIES_MAX 64

/* whether a msgpack integer is a command number: from 1 to 2^53 - 1, so that every client's
   numbers are exact */
static bool is_number(mpack_node_t n) {
    if (mpack_node_type(n) == mpack_type_uint) {
        uint64_t v = mpack_node_u64(n);
        return v >= 1 && v < (1ull << 53);
    }
    return mpack_node_type(n) == mpack_type_int && mpack_node_i64(n) >= 1 &&
           mpack_node_i64(n) < (1ll << 53);
}

/* Whether a parsed request element is [S, n, id, data, expect?]: S a string of 1 to SERIES_MAX
   bytes and n a command number, or both nil, and id ID_LEN bytes of bin.  Elements a later
   protocol appends are ignored. */
static bool is_command(mpack_node_t c) {
    if (mpack_node_type(c) != mpack_type_array || mpack_node_array_length(c) < 4) return false;

    // the series and the number
    mpack_node_t series = mpack_node_array_at(c, 0), n = mpack_node_array_at(c, 1);
    if (mpack_node_type(series) == mpack_type_nil) {
        if (mpack_node_type(n) != mpack_type_nil) return false;
    } else {
        if (mpack_node_type(series) != mpack_type_str) return false;
        size_t slen = mpack_node_strlen(series);
        if (slen < 1 || slen > SERIES_MAX || !is_number(n)) return false;
    }

    // the id
    mpack_node_t id = mpack_node_array_at(c, 2);
    return mpack_node_type(id) == mpack_type_bin && mpack_node_bin_size(id) == ID_LEN;
}

/* whether a msgpack integer is a seq an expectation may name: from 0 to 2^53 - 1 */
static bool is_seq(mpack_node_t n) {
    if (mpack_node_type(n) == mpack_type_uint) return mpack_node_u64(n) < (1ull << 53);
    return mpack_node_type(n) == mpack_type_int && mpack_node_i64(n) >= 0 &&
           mpack_node_i64(n) < (1ll << 53);
}

/* orders msgpack strings bytewise */
static int str_cmp(const void *a, const void *b) {
    mpack_node_t x = *(const mpack_node_t *)a, y = *(const mpack_node_t *)b;
    size_t xn = mpack_node_strlen(x), yn = mpack_node_strlen(y);
    int d = memcmp(mpack_node_str(x), mpack_node_str(y), xn < yn ? xn : yn);
    return d ? d : (xn > yn) - (xn < yn);
}

/* Why a command's expectations are malformed, or NULL when they are a map from at most
   EXPECT_MAX distinct exact stream names to seqs. */
static char *expect_reason(pldb *db, mpack_node_t e) {
    if (mpack_node_type(e) != mpack_type_map) return xstrdup("expect must be a map");
    size_t n = mpack_node_map_count(e);
    if (n > EXPECT_MAX) return reasonf("expect names %zu streams, more than %d", n, EXPECT_MAX);

    // each entry an exact stream name and a seq
    mpack_node_t names[EXPECT_MAX];
    buf name = {0};
    char *reason = NULL;
    for (size_t i = 0; i < n && !reason; i++) {
        names[i] = mpack_node_map_key_at(e, i);
        if (mpack_node_type(names[i]) != mpack_type_str) {
            reason = xstrdup("expect: a stream name is not a string");
            break;
        }
        const char *s = mpack_node_str(names[i]);
        size_t len = mpack_node_strlen(names[i]);
        int shown = len < 100 ? (int)len : 100;
        name.len = 0;
        if (len) buf_append(&name, s, len);
        buf_append(&name, "", 1);
        if (memchr(s, 0, len) || !stream_fills(&db->js, (const char *)name.p)) {
            reason = reasonf("expect: %.*s is not a stream name", shown, s);
        } else if (!is_seq(mpack_node_map_value_at(e, i))) {
            reason = reasonf("expect: the seq of %.*s is not an integer from 0 to 2^53 - 1", shown,
                             s);
        }
    }
    buf_free(&name);
    if (reason) return reason;

    // no stream named twice
    qsort(names, n, sizeof *names, str_cmp);
    for (size_t i = 1; i < n; i++) {
        if (str_cmp(&names[i - 1], &names[i]) != 0) continue;
        size_t len = mpack_node_strlen(names[i]);
        return reasonf("expect: %.*s is named twice", len < 100 ? (int)len : 100,
                       mpack_node_str(names[i]));
    }
    return NULL;
}

/* write a command's expectations as expect_reason passed them, each seq a u64 */
static void write_expect(mpack_writer_t *w, mpack_node_t e) {
    size_t n = mpack_node_map_count(e);
    mpack_start_map(w, (uint32_t)n);
    for (size_t i = 0; i < n; i++) {
        mpack_node_t k = mpack_node_map_key_at(e, i);
        mpack_write_str(w, mpack_node_str(k), (uint32_t)mpack_node_strlen(k));
        mpack_write_u64(w, mpack_node_u64(mpack_node_map_value_at(e, i)));
    }
    mpack_finish_map(w);
}

/* write a command's series as its key in the series table: the hex SHA-256 of its bytes, so
   that nothing the database stores lets its reader send under a live series */
static void write_series_key(mpack_writer_t *w, mpack_node_t series) {
    SHA256_CTX sha;
    BYTE digest[SHA256_BLOCK_SIZE];
    sha256_init(&sha);
    sha256_update(&sha, (const BYTE *)mpack_node_str(series), mpack_node_strlen(series));
    sha256_final(&sha, digest);
    char hex[2 * SHA256_BLOCK_SIZE + 1];
    for (int i = 0; i < SHA256_BLOCK_SIZE; i++) snprintf(hex + 2 * i, 3, "%02x", digest[i]);
    mpack_write_str(w, hex, 2 * SHA256_BLOCK_SIZE);
}

/* the CommandAuth proofs of a request's passing commands */
typedef struct proof_list {
    pldb_proof *v;
    size_t n, cap;
} proof_list;

static void proof_push(proof_list *l, size_t command, mpack_node_t password) {
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 4;
        l->v = realloc(l->v, l->cap * sizeof *l->v);
        if (!l->v) die("out of memory");
    }
    pldb_proof *p = &l->v[l->n++];
    p->command = command;
    p->password = xmalloc(mpack_node_strlen(password) + 1);
    memcpy(p->password, mpack_node_str(password), mpack_node_strlen(password));
    p->password[mpack_node_strlen(password)] = 0;
}

static void proofs_free(pldb_proof *v, size_t n) {
    for (size_t i = 0; i < n; i++) free(v[i].password);
    free(v);
}

/* Check one command's data and prepare its fields: a NewPassword is hashed, and a password
   CommandAuth is replaced by its result and its password appended to proofs, under index, the
   command's in the request; any other kind cannot be verified yet.  Writes the prepared
   [key, n, id, data, expect?] to out, its series replaced by its key, or answers why the
   command is rejected; a hash function's refusal sets *refused instead, and answers NULL. */
static char *prepare_command(pldb *db, uintptr_t arg, mpack_node_t c, size_t index, buf *out,
                             proof_list *proofs, int *refused) {
    long commands = schema_commands(db->js.sc);
    if (commands < 0) return xstrdup("this database takes no commands");
    mpack_node_t data = mpack_node_array_at(c, 3);
    char why[512];
    intake_list il = {0};
    size_t proofs_start = proofs->n;
    char *reason = NULL;
    if (walk_check(db->js.sc, data, commands, true, &il, why, sizeof why)) {
        reason = xstrdup(why);
        goto done;
    }
    if (mpack_node_array_length(c) > 4) {
        reason = expect_reason(db, mpack_node_array_at(c, 4));
        if (reason) goto done;
    }

    // each proof, whose password the caller checks, before any hash is spent on the command
    for (size_t k = 0; k < il.n; k++) {
        intake *in = &il.v[k];
        if (strcmp(in->kind, "CommandAuth") != 0) continue;
        mpack_node_t kind = mpack_node_map_cstr(in->node, "kind");
        if (mpack_node_strlen(kind) != 8 || memcmp(mpack_node_str(kind), "password", 8) != 0) {
            reason = reasonf("%.*s proofs are not supported by this database yet",
                             (int)mpack_node_strlen(kind), mpack_node_str(kind));
            goto done;
        }
        proof_push(proofs, index, mpack_node_map_cstr(in->node, "password"));
        in->result_kind = "password";
    }

    // each other prepared field's result
    for (size_t k = 0; k < il.n; k++) {
        intake *in = &il.v[k];
        if (strcmp(in->kind, "CommandAuth") == 0) continue;
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
    size_t len = mpack_node_array_length(c) > 4 ? 5 : 4;
    mpack_node_t series = mpack_node_array_at(c, 0), id = mpack_node_array_at(c, 2);
    mpack_start_array(&w, (uint32_t)len);
    if (mpack_node_type(series) == mpack_type_nil) {
        mpack_write_nil(&w);
        mpack_write_nil(&w);
    } else {
        write_series_key(&w, series);
        mpack_write_u64(&w, (uint64_t)mpack_node_i64(mpack_node_array_at(c, 1)));
    }
    mpack_write_bin(&w, mpack_node_bin_data(id), ID_LEN);
    int rc = walk_write(db->js.sc, data, commands, true, &il, &w, why, sizeof why);
    if (rc == 0 && len > 4) write_expect(&w, mpack_node_array_at(c, 4));
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

    // a command that does not pass carries no proofs
    if (reason || *refused) {
        while (proofs->n > proofs_start) free(proofs->v[--proofs->n].password);
    }
    return reason;
}

int pldb_prepare(pldb *db, uintptr_t arg, const uint8_t *body, size_t len, pldb_prepared *out,
                 char *err, size_t errlen) {
    memset(out, 0, sizeof *out);
    mpack_tree_t tree;

    // the request is a sequence of [S, n, id, data, expect?] values: count them, refusing the
    // whole request when any is not one, since nothing can be answered for it
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
        if (!is_command(mpack_tree_root(&tree))) {
            snprintf(err, errlen, "command must be [S, n, id, data, expect?]");
            mpack_tree_destroy(&tree);
            return -1;
        }
    }
    mpack_tree_destroy(&tree);
    out->reasons = xmalloc(sizeof(char *) * (ncmds ? ncmds : 1));
    memset(out->reasons, 0, sizeof(char *) * (ncmds ? ncmds : 1));
    out->offsets = xmalloc(sizeof(size_t) * (ncmds ? ncmds : 1));
    out->n = ncmds;

    // check and prepare each command; a refused hash refuses the request
    buf prepared = {0};
    proof_list proofs = {0};
    int refused = 0;
    mpack_tree_init_data(&tree, (const char *)body, len);
    for (size_t i = 0; i < ncmds && !refused; i++) {
        mpack_tree_parse(&tree);
        out->offsets[i] = prepared.len;
        out->reasons[i] = prepare_command(db, arg, mpack_tree_root(&tree), i, &prepared, &proofs,
                                          &refused);
    }
    mpack_tree_destroy(&tree);
    out->body = prepared.p;
    out->len = prepared.len;
    out->proofs = proofs.v;
    out->nproofs = proofs.n;
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
    free(p->offsets);
    free(p->body);
    proofs_free(p->proofs, p->nproofs);
    memset(p, 0, sizeof *p);
}
