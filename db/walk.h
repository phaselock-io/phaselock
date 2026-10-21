/* The conversion kernel: every typed value crosses as

       source -> schema walk -> sink

   The sources are a parsed msgpack tree (mpack's node API) and a tokenization of a QuickJS
   value; the sinks build JS values, write msgpack, or discard (a check).  The schema is the
   registry the bundle carries, compiled once when the database opens, and the walk checks
   every value against it as it converts. */

#ifndef PLDB_WALK_H
#define PLDB_WALK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mpack.h"
#include "quickjs.h"

struct buf;

/* the tokenization of a QuickJS value ///////////////////////////////////// */

enum {
    PL_INVALID = 0,
    PL_BEGIN_OBJ,
    PL_END_OBJ,
    PL_BEGIN_ARR,
    PL_END_ARR,
    PL_KEY,
    PL_STRING,
    PL_INT,
    PL_FLOAT,
    PL_BOOL,
    PL_NULL,
    PL_DATE, /* f: milliseconds since the epoch */
};

/* One token.  Strings carry their bytes as a span (soff, num) into the arena; containers carry
   their element count in num and the token index just past their end token in end, so
   skipping a value is a jump. */
typedef struct pl_tok {
    uint8_t kind;
    uint32_t soff;
    uint32_t num;
    uint32_t end;
    int64_t i;
    double f;
} pl_tok;

typedef struct pl_tokbuf {
    pl_tok *toks;
    size_t ntoks, captoks;
    uint8_t *arena;
    size_t narena, caparena;
} pl_tokbuf;

void tb_free(pl_tokbuf *tb);

/* the JS classes the tokenizer tells apart */
typedef struct jsenv {
    JSContext *ctx;
    JSClassID date_class_id;
    JSClassID set_class_id;
    JSClassID map_class_id;
} jsenv;

/* learn the class ids; -1 on a JS exception */
int jsenv_init(jsenv *env, JSContext *ctx);
/* Tokenize one JS value into tb, emptied first.  Returns 0, or -1 with a message. */
int jstok_tokenize(jsenv *env, JSValueConst v, pl_tokbuf *tb, char *err, size_t errlen);

/* schema ////////////////////////////////////////////////////////////////// */

typedef struct schema schema;

/* Compile the registry data from a tokenized JS object ({nodes, ids, mutations}).  Fails on a
   malformed table and on an intake kind this database cannot run.  Returns NULL with a
   message. */
schema *schema_compile(const pl_tokbuf *tb, char *err, size_t errlen);
void schema_free(schema *sc);
/* a type identity's node, -1 when unknown */
long schema_lookup(const schema *sc, const char *id, size_t len);
/* the mutations union's node, -1 when the database has no mutations */
long schema_mutations(const schema *sc);

/* walks /////////////////////////////////////////////////////////////////// */

/* One field the database prepares for the decider, met by a check: its kind, its key, its value,
   and the result to write in its place, which the caller fills in: a string the list owns, or a
   MutationAuthResult's kind, written as {kind}. */
typedef struct intake {
    const char *kind;
    char key[256];
    mpack_node_t node;
    char *result;
    const char *result_kind;
} intake;

typedef struct intake_list {
    intake *v;
    size_t n, cap;
} intake_list;

void intake_list_free(intake_list *l);

/* Check a msgpack value against a type.  strict rejects fields the schema does not name, as a
   mutation's are; otherwise they are dropped.  When il is given, every prepared field of the
   top-level value is appended to it.  Returns 0, or -1 with the first error, which names the
   path. */
int walk_check(const schema *sc, mpack_node_t node, long type, bool strict, intake_list *il,
               char *err, size_t errlen);

/* Write a msgpack value as checked under a type, to out: the discriminator first, declaration
   order, fields the schema does not name dropped, and each prepared field of the top-level value
   replaced by its result in il when il is given.  type < 0 copies the value untyped.  Returns 0,
   or -1 with a message. */
int walk_write(const schema *sc, mpack_node_t node, long type, bool strict, const intake_list *il,
               mpack_writer_t *out, char *err, size_t errlen);

/* Build the JS value of a msgpack value.  Returns JS_EXCEPTION with a message when the value
   fails its type, or with a pending JS exception when the heap did. */
JSValue walk_to_js(JSContext *ctx, const schema *sc, mpack_node_t node, long type, bool strict,
                   char *err, size_t errlen);

/* Build the JS value of a mutation walk_write prepared: walked strictly under type as
   walk_to_js walks it, except that each prepared field of the top-level value holds the result
   written in its place and is converted as it is. */
JSValue walk_prepared_to_js(JSContext *ctx, const schema *sc, mpack_node_t node, long type,
                            char *err, size_t errlen);

/* Write a JS value as msgpack, appended to out.  Returns 0, or -1 with a message. */
int walk_to_mpack(jsenv *env, const schema *sc, JSValueConst v, long type, bool strict,
                  struct buf *out, char *err, size_t errlen);

#endif
