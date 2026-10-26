/* PhaseLock database core: the C API the Go layer binds through cgo. */

#ifndef PLDB_H
#define PLDB_H

#include <stddef.h>
#include <stdint.h>

typedef struct pldb pldb;

enum {
    PLDB_R_SHUTDOWN = 0,
    PLDB_R_COMMIT = 1,  /* items: every edit of one group commit, in order */
    PLDB_R_OUTCOME = 2, /* reqid, buf: msgpack array of per-mutation outcomes */
    PLDB_R_VIEW = 3,    /* conn: initial or changed grant */
    PLDB_R_LOOKUP = 4,  /* reqid, buf: msgpack of lookup's return, len 0 for null */
    PLDB_R_ARM = 5,     /* reqid, marks: every cron entry's mark, in entry order */
    PLDB_R_TICK = 6,    /* reqid; status 500 with errmsg when the tick's hook failed */
    PLDB_R_KEY = 7,     /* reqid: a token key and its sweep are durable */
};

/* One edit as the wire sees it: data is the edit's msgpack array, its envelope and its payload's
   items, and position the position of its mutation, which the mutation's other edits share. */
typedef struct pldb_item {
    char *slice;
    uint64_t position;
    uint8_t *data;
    size_t len;
} pldb_item;

typedef struct pldb_result {
    int kind;
    int status;        /* 0 ok; 401 stale token; 500 with errmsg */
    /* an outcome that stopped at a proven mutation whose credentials changed after its proof was
       checked: buf holds the outcomes of the mutations before it, and hash what lookup answers
       now, NULL for none */
    int bounce;
    char *hash;
    uint64_t reqid;
    uint64_t conn;
    uint64_t position; /* last committed position when this result was made */
    pldb_item *items;
    size_t nitems;
    uint8_t *buf;
    size_t len;
    char **selectors; /* what the grantor allows, sorted and unique */
    size_t nselectors;
    int64_t *marks;
    size_t nmarks;
    char *errmsg;
    struct pldb_result *next;
} pldb_result;

/* What a hash function answers: a hash, a refusal of this request's hashing (the pool is full,
   the client's budget is spent, or the client or server is going away), or a failure. */
enum {
    PLDB_HASH_OK = 0,
    PLDB_HASH_BUSY = 1,
    PLDB_HASH_LIMITED = 2,
    PLDB_HASH_FAILED = -1,
};

/* Hashes a password into out (NUL-terminated), for the request arg names; answers one of the
   PLDB_HASH_ codes. */
typedef int (*pldb_hash_fn)(uintptr_t arg, const char *pw, size_t pwlen, char *out, size_t cap);

/* host is the JS host's source, host.js, which the Go layer embeds; env names the variables the
   bundle's bootstrap may read; on an empty log, open runs it.  cache_mib is the page cache of
   each SQLite connection, the writer's and the reader's, in MiB. */
int pldb_open(const char *dir, const char *host, size_t hostlen, const char *bundle,
              pldb_hash_fn hasher, const char *const *env, int nenv, int cache_mib, pldb **out,
              char *err, size_t errlen);
void pldb_close(pldb *db);
/* the id of this log instance; positions mean nothing across epochs */
const char *pldb_epoch(pldb *db);

/* A proven mutation's verdict: whether it carries a MutationAuth proof, and if so whether its
   proof passed against hash, the password hash lookup answered for the sender's token when the
   proof was checked, NULL for none. */
enum {
    PLDB_PROOF_NONE = 0,
    PLDB_PROOF_PASSED = 1,
    PLDB_PROOF_FAILED = 2,
};
typedef struct pldb_verdict {
    int state;
    const char *hash;
} pldb_verdict;

/* The writer bounces a call at most this many times; past it, a proven mutation whose
   credentials changed again is rejected as a bug in lookup. */
#define PLDB_MAX_BOUNCES 3

/* Requests; answered through pldb_pop.  user NULL is anonymous; gen < 0 skips
   the generation check.  A submit's body is mutations pldb_prepare prepared, with one verdict
   per mutation, or none when nverdicts is 0, and attempt the number of times the call has
   bounced.  The writer checks a proven mutation against what lookup answers when its turn comes:
   when the hash differs from its verdict's, it stops the call there and answers a bounce, and
   otherwise a failed verdict is rejected. */
int pldb_submit(pldb *db, uint64_t reqid, const char *user, int64_t gen, const uint8_t *body,
                size_t len, const pldb_verdict *verdicts, size_t nverdicts, int attempt);
int pldb_register(pldb *db, uint64_t reqid, uint64_t conn, const char *user, int64_t gen);
int pldb_unregister(pldb *db, uint64_t conn);
int pldb_lookup(pldb *db, uint64_t reqid, const uint8_t *ident, size_t len);

/* Cron.  The bundle's cron entries are read when the database opens: every entry of every cron
   install, in install and entry order, which db owns.  An entry's mark is the last of its slots
   decided, a Unix time in seconds.  pldb_cron_arm gives every entry without a mark the mark
   minute and answers every entry's mark as a PLDB_R_ARM; pldb_cron_tick decides slot of entry
   i, running its hook unless the slot is at or below its mark, and answers a PLDB_R_TICK.  Both
   run on the writer, as mutations do. */
typedef struct pldb_cron_entry {
    const char *install;
    const char *entry;
    const char *spec;
} pldb_cron_entry;
size_t pldb_cron_entries(pldb *db, const pldb_cron_entry **out);
int pldb_cron_arm(pldb *db, uint64_t reqid, int64_t minute);
int pldb_cron_tick(pldb *db, uint64_t reqid, size_t i, int64_t slot);

/* Token keys: the public keys tokens are verified against, each with its id and the Unix
   milliseconds it was minted.  pldb_keys reads every key, oldest first, on the caller's thread;
   pldb_key_add stores one and deletes the keys sweep names, in one commit on the writer, and
   answers a PLDB_R_KEY once both are durable. */
typedef struct pldb_key {
    char *kid;
    uint8_t *pub;
    size_t len;
    int64_t minted;
} pldb_key;
int pldb_keys(pldb *db, pldb_key **out, size_t *n);
void pldb_keys_free(pldb_key *keys, size_t n);
int pldb_key_add(pldb *db, uint64_t reqid, const pldb_key *key, const char *const *sweep,
                 size_t nsweep);

/* Blocks until a result is available.  The caller frees it. */
pldb_result *pldb_pop(pldb *db);
void pldb_result_free(pldb_result *r);

/* The check of a request's mutations, on the caller's thread: every mutation is checked
   against the bundle's registry, and the fields the database prepares for the decider are
   prepared, before anything reaches the writer.  body holds the mutations that passed, in
   order; reasons has one entry per mutation of the request, NULL for one that passed and
   why it was rejected otherwise, and offsets one, the start in body of a mutation that passed.
   Each passing mutation's series is replaced by its key in the series table.  arg is handed to
   the hash function for every password the request carries.  A MutationAuth proof is replaced
   by its result, and its password goes to proofs for the caller to check; a proof of any other
   kind rejects its mutation.  Returns 0; -1 for a request that is not a sequence of
   [S, n, id, data, expect?] values; PLDB_TOO_MANY for one of more than max mutations, refused
   before any is checked; or PLDB_HASH_BUSY or PLDB_HASH_LIMITED when the hash function refused,
   which refuses the whole request, so the client can retry it later under the same series and
   numbers. */
enum { PLDB_TOO_MANY = 3 };
typedef struct pldb_proof {
    size_t mutation; /* its mutation's index in the request */
    char *password;
} pldb_proof;
typedef struct pldb_prepared {
    uint8_t *body;
    size_t len;
    char **reasons;
    size_t *offsets;
    size_t n;
    pldb_proof *proofs;
    size_t nproofs;
} pldb_prepared;
int pldb_prepare(pldb *db, uintptr_t arg, const uint8_t *body, size_t len, size_t max,
                 pldb_prepared *out, char *err, size_t errlen);
void pldb_prepared_free(pldb_prepared *p);

/* Reader side: any thread, serialized internally. */
/* the log's edits with from <= position <= to, by position, then slice */
int pldb_read_log(pldb *db, uint64_t from, uint64_t to, pldb_item **items, size_t *n);
/* A selector's edits with from < position < to, by position ascending or descending, then by slice:
   limit of them, and the rest of the last one's position, since a read never splits the edits of
   one mutation, or fewer when the range runs out.  A selector is a slice name, a prefix selector
   such as "chat:*" or "chat:acme,*", or "*". */
int pldb_read_edits(pldb *db, const char *selector, uint64_t from, uint64_t to, int reverse,
                    size_t limit, pldb_item **items, size_t *n);
void pldb_items_free(pldb_item *items, size_t n);
int pldb_snapshot(pldb *db, const char *selector, uint8_t **out, size_t *len, uint64_t *position);
void pldb_free(void *p);

/* Test only: the scan conformance test's hold on the pattern walk (scantest.c).  It opens the
   bundle's JS host, host.js's source being host, over a store at path, its scans stepping through
   budget keys before a seek, or the core's own number for a negative budget; stores keys with
   string values converted under a type and past the write gate, and answers a scan request given
   as JSON with its batch as JSON, or with the message of what it threw and *failed set.  The
   caller frees the answer. */
/* Tests only: while held, the transaction loop takes no batch, so the requests queued meanwhile
   land in one when it is released; and how many requests are queued for the next batch. */
void pldb_hold_batches(pldb *db, int hold);
size_t pldb_queued(pldb *db);

typedef struct pldb_scantest pldb_scantest;
pldb_scantest *pldb_scantest_open(const char *host, size_t hostlen, const char *bundle,
                                  const char *path, int budget, char *err, size_t errlen);
void pldb_scantest_close(pldb_scantest *t);
int pldb_scantest_put(pldb_scantest *t, const char *key, const char *type, const char *value,
                      char *err, size_t errlen);
char *pldb_scantest_scan(pldb_scantest *t, const char *req, int *failed);

#endif
