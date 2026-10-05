/* The conversion kernel.  See walk.h. */

#include <math.h>
#include <stdarg.h>

#include "internal.h"
#include "walk.h"

#define MAX_DEPTH 512

// tokens ///////////////////////////////////////////////////////////////////

static long tok_push(pl_tokbuf *tb, pl_tok tok) {
    if (tb->ntoks == tb->captoks) {
        size_t cap = tb->captoks ? tb->captoks * 2 : 256;
        pl_tok *toks = realloc(tb->toks, cap * sizeof *toks);
        if (!toks) die("out of memory");
        tb->toks = toks;
        tb->captoks = cap;
    }
    tb->toks[tb->ntoks] = tok;
    return (long)tb->ntoks++;
}

static uint32_t arena_push(pl_tokbuf *tb, const void *bytes, size_t len) {
    if (tb->narena + len > tb->caparena) {
        size_t cap = tb->caparena ? tb->caparena * 2 : 1024;
        while (cap < tb->narena + len) cap *= 2;
        uint8_t *arena = realloc(tb->arena, cap);
        if (!arena) die("out of memory");
        tb->arena = arena;
        tb->caparena = cap;
    }
    if (len) memcpy(tb->arena + tb->narena, bytes, len);
    uint32_t out = (uint32_t)tb->narena;
    tb->narena += len;
    return out;
}

void tb_free(pl_tokbuf *tb) {
    free(tb->toks);
    free(tb->arena);
    memset(tb, 0, sizeof *tb);
}

/* the bytes of a string or key token */
static const char *tok_span(const pl_tokbuf *tb, const pl_tok *t, size_t *len) {
    *len = t->num;
    return (const char *)tb->arena + t->soff;
}

/* the index just past the value whose first token is at idx */
static size_t tok_skip(const pl_tokbuf *tb, size_t idx) {
    const pl_tok *t = &tb->toks[idx];
    if (t->kind == PL_BEGIN_OBJ || t->kind == PL_BEGIN_ARR) return t->end;
    return idx + 1;
}

// the JS heap tokenizer ////////////////////////////////////////////////////

static int learn_class_id(JSContext *ctx, const char *expr, JSClassID *out) {
    JSValue v = JS_Eval(ctx, expr, strlen(expr), "<class-id>", 0);
    if (JS_IsException(v)) return -1;
    *out = JS_GetClassID(v);
    JS_FreeValue(ctx, v);
    return 0;
}

int jsenv_init(jsenv *env, JSContext *ctx) {
    env->ctx = ctx;
    return learn_class_id(ctx, "new Date(0)", &env->date_class_id) ||
           learn_class_id(ctx, "new Set()", &env->set_class_id) ||
           learn_class_id(ctx, "new Map()", &env->map_class_id);
}

typedef struct jstok {
    jsenv *env;
    pl_tokbuf *tb;
    int depth;
    char *err;
    size_t errlen;
} jstok;

static int js_fail(jstok *t, const char *msg) {
    snprintf(t->err, t->errlen, "%s", msg);
    return -1;
}

static void js_drop_exception(JSContext *ctx) { JS_FreeValue(ctx, JS_GetException(ctx)); }

static int js_value(jstok *t, JSValueConst v);

static int js_array(jstok *t, JSValueConst v) {
    JSContext *ctx = t->env->ctx;
    JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
    int64_t len = 0;
    int ret = JS_ToInt64Ext(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);
    if (ret < 0 || len < 0 || len > UINT32_MAX) {
        js_drop_exception(ctx);
        return js_fail(t, "bad array length");
    }
    long open = tok_push(t->tb, (pl_tok){.kind = PL_BEGIN_ARR, .num = (uint32_t)len});
    for (int64_t i = 0; i < len; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
        if (JS_IsException(item)) {
            js_drop_exception(ctx);
            return js_fail(t, "reading an array element");
        }
        ret = js_value(t, item);
        JS_FreeValue(ctx, item);
        if (ret) return -1;
    }
    tok_push(t->tb, (pl_tok){.kind = PL_END_ARR});
    t->tb->toks[open].end = (uint32_t)t->tb->ntoks;
    return 0;
}

static int js_object(jstok *t, JSValueConst v) {
    JSContext *ctx = t->env->ctx;
    JSPropertyEnum *props = NULL;
    uint32_t nprops = 0;
    if (JS_GetOwnPropertyNames(ctx, &props, &nprops, v, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        js_drop_exception(ctx);
        return js_fail(t, "listing object keys");
    }
    int out = -1;
    long open = tok_push(t->tb, (pl_tok){.kind = PL_BEGIN_OBJ});
    uint32_t n = 0;
    for (uint32_t i = 0; i < nprops; i++) {
        JSValue val = JS_GetProperty(ctx, v, props[i].atom);
        if (JS_IsException(val)) {
            js_drop_exception(ctx);
            js_fail(t, "reading an object property");
            goto done;
        }
        // a property holding undefined is absent
        if (JS_IsUndefined(val)) continue;
        size_t klen;
        const char *k = JS_AtomToCStringLen(ctx, &klen, props[i].atom);
        if (!k) {
            JS_FreeValue(ctx, val);
            js_drop_exception(ctx);
            js_fail(t, "reading an object key");
            goto done;
        }
        uint32_t soff = arena_push(t->tb, k, klen);
        JS_FreeCString(ctx, k);
        tok_push(t->tb, (pl_tok){.kind = PL_KEY, .soff = soff, .num = (uint32_t)klen});
        int ret = js_value(t, val);
        JS_FreeValue(ctx, val);
        if (ret) goto done;
        n++;
    }
    tok_push(t->tb, (pl_tok){.kind = PL_END_OBJ});
    t->tb->toks[open].num = n;
    t->tb->toks[open].end = (uint32_t)t->tb->ntoks;
    out = 0;

done:
    if (props) JS_FreePropertyEnum(ctx, props, nprops);
    return out;
}

static int js_value(jstok *t, JSValueConst v) {
    JSContext *ctx = t->env->ctx;
    if (++t->depth > MAX_DEPTH) return js_fail(t, "nested too deeply");
    int ret = 0;
    switch (JS_VALUE_GET_NORM_TAG(v)) {
    case JS_TAG_UNDEFINED:
    case JS_TAG_NULL: tok_push(t->tb, (pl_tok){.kind = PL_NULL}); break;
    case JS_TAG_BOOL: tok_push(t->tb, (pl_tok){.kind = PL_BOOL, .i = JS_VALUE_GET_BOOL(v) != 0}); break;
    case JS_TAG_INT: tok_push(t->tb, (pl_tok){.kind = PL_INT, .i = JS_VALUE_GET_INT(v)}); break;
    case JS_TAG_FLOAT64: {
        double f = JS_VALUE_GET_FLOAT64(v);
        if (isfinite(f) && f == floor(f) && fabs(f) < 9007199254740992.0)
            tok_push(t->tb, (pl_tok){.kind = PL_INT, .i = (int64_t)f});
        else
            tok_push(t->tb, (pl_tok){.kind = PL_FLOAT, .f = f});
        break;
    }
    case JS_TAG_SHORT_BIG_INT:
    case JS_TAG_BIG_INT: {
        int64_t i;
        if (JS_ToInt64Ext(ctx, &i, v) < 0) {
            js_drop_exception(ctx);
            ret = js_fail(t, "bigint out of range");
            break;
        }
        tok_push(t->tb, (pl_tok){.kind = PL_INT, .i = i});
        break;
    }
    case JS_TAG_STRING:
    case JS_TAG_STRING_ROPE: {
        size_t len;
        const char *s = JS_ToCStringLen(ctx, &len, v);
        if (!s) {
            js_drop_exception(ctx);
            ret = js_fail(t, "reading a string");
            break;
        }
        uint32_t soff = arena_push(t->tb, s, len);
        JS_FreeCString(ctx, s);
        tok_push(t->tb, (pl_tok){.kind = PL_STRING, .soff = soff, .num = (uint32_t)len});
        break;
    }
    case JS_TAG_OBJECT: {
        JSClassID cls = JS_GetClassID(v);
        if (cls == t->env->date_class_id) {
            double ms;
            if (JS_ToFloat64(ctx, &ms, v) < 0) {
                js_drop_exception(ctx);
                ret = js_fail(t, "reading a Date");
                break;
            }
            tok_push(t->tb, (pl_tok){.kind = PL_DATE, .f = ms});
            break;
        }
        if (cls == t->env->set_class_id || cls == t->env->map_class_id) {
            ret = js_fail(t, "Set and Map values are not supported");
            break;
        }
        if (JS_IsFunction(ctx, v)) {
            ret = js_fail(t, "a function is not a value");
            break;
        }
        int is_array = JS_IsArray(ctx, v);
        if (is_array < 0) {
            js_drop_exception(ctx);
            ret = js_fail(t, "array check failed");
            break;
        }
        ret = is_array ? js_array(t, v) : js_object(t, v);
        break;
    }
    default: ret = js_fail(t, "unsupported JS value");
    }
    t->depth--;
    return ret;
}

int jstok_tokenize(jsenv *env, JSValueConst v, pl_tokbuf *tb, char *err, size_t errlen) {
    tb->ntoks = 0;
    tb->narena = 0;
    jstok t = {.env = env, .tb = tb, .err = err, .errlen = errlen};
    return js_value(&t, v);
}

// the schema ///////////////////////////////////////////////////////////////

/* The registry data, compiled into a table the walk interprets.  The table points into the
   schema's own copy of the tokens it was compiled from, so the schema owns those. */

enum { N_NULL, N_INT, N_STR, N_BOOL, N_DATE, N_JSON, N_LIT, N_STRUCT, N_RECORD, N_ARRAY, N_TUPLE, N_UNION, N_INTAKE };
enum { L_STR, L_INT, L_BOOL };
enum { S_MATCH, S_JSONTYPE, S_LITERAL, S_LENGTH, S_INDEX, S_FIELD, S_HASFIELD };
enum { JT_NULL, JT_INT, JT_STRING, JT_BOOLEAN, JT_OBJECT, JT_ARRAY, JT_ANY, JT_NONE };

typedef struct lit {
    uint8_t kind;
    int64_t i;
    const char *s;
    size_t slen;
} lit;

typedef struct field {
    const char *key;
    size_t keylen;
    uint32_t type;
    bool optional;
} field;

typedef struct sol sol;

typedef struct solopt {
    uint8_t jt;
    lit lit;
    int64_t length;
    const char *key;
    size_t keylen;
    sol *sol;
} solopt;

struct sol {
    uint8_t kind;
    uint32_t type; /* match */
    size_t nopts;  /* jsontype, literal, length, hasfield */
    solopt *opts;
    sol *dflt;       /* length */
    const char *key; /* field */
    size_t keylen;
    int64_t index; /* index */
    sol *sub;      /* index, field */
};

typedef struct node {
    uint8_t kind;
    lit lit;            /* lit */
    uint32_t child;     /* record, array, intake */
    size_t nchildren;   /* tuple, struct */
    uint32_t *children; /* tuple */
    field *fields;      /* struct */
    int disc;           /* struct: the field written first, -1 for none */
    sol *sol;           /* union */
    const char *kind_name; /* intake */
} node;

typedef struct ident {
    const char *id;
    size_t idlen;
    uint32_t idx;
} ident;

typedef struct mapping {
    const char *key;
    size_t keylen;
    const char *value;
    size_t valuelen;
} mapping;

struct schema {
    node *nodes;
    size_t nnodes;
    ident *ids;
    size_t nids;
    long commands;
    mapping *event_types;
    size_t nevent_types;
    mapping *store_types;
    size_t nstore_types;
    pl_tokbuf tb; /* the table points into these tokens */
};

/* the intake kinds this database can run; a schema naming another cannot be loaded */
static const char *const INTAKE_KINDS[] = {"NewPassword", "CommandAuth", "CaptchaToken", "IdentityProof"};

static void sol_free(sol *s) {
    if (!s) return;
    for (size_t i = 0; i < s->nopts; i++) sol_free(s->opts[i].sol);
    free(s->opts);
    sol_free(s->dflt);
    sol_free(s->sub);
    free(s);
}

void schema_free(schema *sc) {
    if (!sc) return;
    for (size_t i = 0; i < sc->nnodes; i++) {
        free(sc->nodes[i].children);
        free(sc->nodes[i].fields);
        sol_free(sc->nodes[i].sol);
    }
    free(sc->nodes);
    free(sc->ids);
    free(sc->event_types);
    free(sc->store_types);
    tb_free(&sc->tb);
    free(sc);
}

/* a cursor over the schema's tokens; the first failure poisons every later step */
typedef struct scur {
    schema *sc;
    size_t pos;
    char err[256];
    bool failed;
} scur;

static int scur_fail(scur *c, const char *fmt, ...) {
    if (c->failed) return -1;
    c->failed = true;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(c->err, sizeof c->err, fmt, ap);
    va_end(ap);
    return -1;
}

static const pl_tok *scur_next(scur *c) {
    if (c->failed) return NULL;
    if (c->pos >= c->sc->tb.ntoks) {
        scur_fail(c, "schema: unexpected end");
        return NULL;
    }
    return &c->sc->tb.toks[c->pos++];
}

static const pl_tok *scur_peek(scur *c) {
    if (c->failed || c->pos >= c->sc->tb.ntoks) return NULL;
    return &c->sc->tb.toks[c->pos];
}

/* enter an array: its count, the cursor at its first element, and the index past its end */
static long scur_enter_arr(scur *c, size_t *end) {
    const pl_tok *t = scur_next(c);
    if (!t) return -1;
    if (t->kind != PL_BEGIN_ARR) {
        scur_fail(c, "schema: expected an array");
        return -1;
    }
    *end = t->end;
    return (long)t->num;
}

static const char *scur_str(scur *c, size_t *len) {
    const pl_tok *t = scur_next(c);
    if (!t) return NULL;
    if (t->kind != PL_STRING) {
        scur_fail(c, "schema: expected a string");
        return NULL;
    }
    return tok_span(&c->sc->tb, t, len);
}

static long scur_int(scur *c) {
    const pl_tok *t = scur_next(c);
    if (!t) return -1;
    if (t->kind != PL_INT || t->i < 0) {
        scur_fail(c, "schema: expected a non-negative int");
        return -1;
    }
    return (long)t->i;
}

static int scur_lit(scur *c, lit *out) {
    const pl_tok *t = scur_next(c);
    if (!t) return -1;
    if (t->kind == PL_STRING) {
        size_t len;
        const char *s = tok_span(&c->sc->tb, t, &len);
        *out = (lit){.kind = L_STR, .s = s, .slen = len};
        return 0;
    }
    if (t->kind == PL_INT) {
        *out = (lit){.kind = L_INT, .i = t->i};
        return 0;
    }
    if (t->kind == PL_BOOL) {
        *out = (lit){.kind = L_BOOL, .i = t->i};
        return 0;
    }
    return scur_fail(c, "schema: a literal must be a string, an int, or a bool");
}

static bool span_eq(const char *s, size_t len, const char *want) {
    return len == strlen(want) && memcmp(s, want, len) == 0;
}

static int scur_type_index(scur *c, uint32_t *out) {
    long i = scur_int(c);
    if (i < 0) return -1;
    if ((size_t)i >= c->sc->nnodes) return scur_fail(c, "schema: a type index is out of range");
    *out = (uint32_t)i;
    return 0;
}

/* a null, or a string: null gives NULL with no failure */
static int scur_name(scur *c, const char **out) {
    const pl_tok *t = scur_peek(c);
    if (!t) return scur_fail(c, "schema: unexpected end");
    if (t->kind == PL_NULL) {
        c->pos++;
        *out = NULL;
        return 0;
    }
    size_t len;
    *out = scur_str(c, &len);
    return *out ? 0 : -1;
}

static sol *parse_sol(scur *c);

/* [[key, solution], ...] option arrays; parse_key fills the half before the solution */
static int parse_opts(scur *c, sol *s, int (*parse_key)(scur *, solopt *)) {
    size_t end;
    long n = scur_enter_arr(c, &end);
    if (n < 0) return -1;
    s->opts = calloc((size_t)n + 1, sizeof *s->opts);
    if (!s->opts) die("out of memory");
    s->nopts = (size_t)n;
    for (long i = 0; i < n; i++) {
        size_t pair_end;
        if (scur_enter_arr(c, &pair_end) != 2) return scur_fail(c, "schema: expected a pair");
        if (parse_key(c, &s->opts[i])) return -1;
        s->opts[i].sol = parse_sol(c);
        if (!s->opts[i].sol) return -1;
        c->pos = pair_end;
    }
    c->pos = end;
    return 0;
}

static int optkey_jt(scur *c, solopt *o) {
    size_t len;
    const char *s = scur_str(c, &len);
    if (!s) return -1;
    if (span_eq(s, len, "null")) o->jt = JT_NULL;
    else if (span_eq(s, len, "int")) o->jt = JT_INT;
    else if (span_eq(s, len, "string")) o->jt = JT_STRING;
    else if (span_eq(s, len, "boolean")) o->jt = JT_BOOLEAN;
    else if (span_eq(s, len, "object")) o->jt = JT_OBJECT;
    else if (span_eq(s, len, "array")) o->jt = JT_ARRAY;
    else if (span_eq(s, len, "*")) o->jt = JT_ANY;
    else return scur_fail(c, "schema: unknown json type");
    return 0;
}

static int optkey_lit(scur *c, solopt *o) { return scur_lit(c, &o->lit); }

static int optkey_length(scur *c, solopt *o) {
    long n = scur_int(c);
    if (n < 0) return -1;
    o->length = n;
    return 0;
}

static int optkey_field(scur *c, solopt *o) {
    o->key = scur_str(c, &o->keylen);
    return o->key ? 0 : -1;
}

static sol *parse_sol(scur *c) {
    size_t end;
    if (scur_enter_arr(c, &end) < 0) return NULL;
    size_t kindlen;
    const char *kind = scur_str(c, &kindlen);
    if (!kind) return NULL;
    sol *s = calloc(1, sizeof *s);
    if (!s) die("out of memory");
    if (span_eq(kind, kindlen, "match")) {
        s->kind = S_MATCH;
        if (scur_type_index(c, &s->type)) goto fail;
    } else if (span_eq(kind, kindlen, "jsontype")) {
        s->kind = S_JSONTYPE;
        if (parse_opts(c, s, optkey_jt)) goto fail;
    } else if (span_eq(kind, kindlen, "literal")) {
        s->kind = S_LITERAL;
        if (parse_opts(c, s, optkey_lit)) goto fail;
    } else if (span_eq(kind, kindlen, "length")) {
        s->kind = S_LENGTH;
        if (parse_opts(c, s, optkey_length)) goto fail;
        const pl_tok *t = scur_peek(c);
        if (t && t->kind == PL_NULL) {
            c->pos++;
        } else {
            s->dflt = parse_sol(c);
            if (!s->dflt) goto fail;
        }
    } else if (span_eq(kind, kindlen, "index")) {
        s->kind = S_INDEX;
        s->index = scur_int(c);
        if (s->index < 0) goto fail;
        s->sub = parse_sol(c);
        if (!s->sub) goto fail;
    } else if (span_eq(kind, kindlen, "field")) {
        s->kind = S_FIELD;
        s->key = scur_str(c, &s->keylen);
        if (!s->key) goto fail;
        s->sub = parse_sol(c);
        if (!s->sub) goto fail;
    } else if (span_eq(kind, kindlen, "hasfield")) {
        s->kind = S_HASFIELD;
        if (parse_opts(c, s, optkey_field)) goto fail;
    } else {
        scur_fail(c, "schema: unknown solution kind");
        goto fail;
    }
    c->pos = end;
    return s;

fail:
    sol_free(s);
    return NULL;
}

static int parse_node(scur *c, node *n) {
    size_t end;
    if (scur_enter_arr(c, &end) < 0) return -1;
    size_t kindlen;
    const char *kind = scur_str(c, &kindlen);
    if (!kind) return -1;
    const char *name;
    n->disc = -1;
    if (span_eq(kind, kindlen, "null")) n->kind = N_NULL;
    else if (span_eq(kind, kindlen, "int")) n->kind = N_INT;
    else if (span_eq(kind, kindlen, "str")) n->kind = N_STR;
    else if (span_eq(kind, kindlen, "bool")) n->kind = N_BOOL;
    else if (span_eq(kind, kindlen, "date")) n->kind = N_DATE;
    else if (span_eq(kind, kindlen, "json")) n->kind = N_JSON;
    else if (span_eq(kind, kindlen, "lit")) {
        n->kind = N_LIT;
        if (scur_lit(c, &n->lit)) return -1;
    } else if (span_eq(kind, kindlen, "struct")) {
        n->kind = N_STRUCT;
        if (scur_name(c, &name)) return -1;
        size_t fields_end;
        long nf = scur_enter_arr(c, &fields_end);
        if (nf < 0) return -1;
        n->fields = calloc((size_t)nf + 1, sizeof *n->fields);
        if (!n->fields) die("out of memory");
        n->nchildren = (size_t)nf;
        for (long i = 0; i < nf; i++) {
            size_t f_end;
            if (scur_enter_arr(c, &f_end) != 3) return scur_fail(c, "schema: expected a field triple");
            field *f = &n->fields[i];
            f->key = scur_str(c, &f->keylen);
            if (!f->key || scur_type_index(c, &f->type)) return -1;
            const pl_tok *t = scur_next(c);
            if (!t || t->kind != PL_BOOL) return scur_fail(c, "schema: optional must be a bool");
            f->optional = t->i != 0;
            c->pos = f_end;
        }
        c->pos = fields_end;

        // the field the struct writes first, or -1
        const pl_tok *d = scur_next(c);
        if (!d || d->kind != PL_INT || d->i < -1 || d->i >= nf) {
            return scur_fail(c, "schema: a struct's discriminator must be a field index or -1");
        }
        n->disc = (int)d->i;
    } else if (span_eq(kind, kindlen, "record") || span_eq(kind, kindlen, "array")) {
        n->kind = kind[0] == 'r' ? N_RECORD : N_ARRAY;
        if (scur_name(c, &name) || scur_type_index(c, &n->child)) return -1;
    } else if (span_eq(kind, kindlen, "tuple")) {
        n->kind = N_TUPLE;
        if (scur_name(c, &name)) return -1;
        size_t items_end;
        long ni = scur_enter_arr(c, &items_end);
        if (ni < 0) return -1;
        n->children = calloc((size_t)ni + 1, sizeof *n->children);
        if (!n->children) die("out of memory");
        n->nchildren = (size_t)ni;
        for (long i = 0; i < ni; i++) {
            if (scur_type_index(c, &n->children[i])) return -1;
        }
        c->pos = items_end;
    } else if (span_eq(kind, kindlen, "union")) {
        n->kind = N_UNION;
        if (scur_name(c, &name)) return -1;
        n->sol = parse_sol(c);
        if (!n->sol) return -1;
    } else if (span_eq(kind, kindlen, "intake")) {
        n->kind = N_INTAKE;
        size_t klen;
        const char *k = scur_str(c, &klen);
        if (!k || scur_type_index(c, &n->child)) return -1;
        n->kind_name = NULL;
        for (size_t i = 0; i < sizeof INTAKE_KINDS / sizeof *INTAKE_KINDS; i++) {
            if (span_eq(k, klen, INTAKE_KINDS[i])) n->kind_name = INTAKE_KINDS[i];
        }
        if (!n->kind_name) {
            return scur_fail(c, "schema names an intake kind this database does not know: %.*s", (int)klen, k);
        }
    } else {
        return scur_fail(c, "schema: unknown node kind");
    }
    c->pos = end;
    return 0;
}

/* a {string: string} object as a mapping list */
static int parse_mappings(scur *c, mapping **out, size_t *n) {
    const pl_tok *obj = scur_next(c);
    if (!obj || obj->kind != PL_BEGIN_OBJ) return scur_fail(c, "schema: expected an object");
    *out = calloc(obj->num + 1, sizeof **out);
    if (!*out) die("out of memory");
    *n = 0;
    while (c->pos < c->sc->tb.ntoks && c->sc->tb.toks[c->pos].kind == PL_KEY) {
        mapping *m = &(*out)[*n];
        m->key = tok_span(&c->sc->tb, &c->sc->tb.toks[c->pos], &m->keylen);
        c->pos++;
        m->value = scur_str(c, &m->valuelen);
        if (!m->value) return -1;
        (*n)++;
    }
    c->pos++; /* the end token */
    return 0;
}

schema *schema_compile(const pl_tokbuf *src, char *err, size_t errlen) {
    schema *sc = calloc(1, sizeof *sc);
    if (!sc) die("out of memory");
    sc->commands = -1;

    // the schema keeps its own copy of the tokens, since the table points into them
    sc->tb.toks = xmalloc(sizeof(pl_tok) * (src->ntoks ? src->ntoks : 1));
    memcpy(sc->tb.toks, src->toks, sizeof(pl_tok) * src->ntoks);
    sc->tb.ntoks = sc->tb.captoks = src->ntoks;
    sc->tb.arena = xmalloc(src->narena ? src->narena : 1);
    memcpy(sc->tb.arena, src->arena, src->narena);
    sc->tb.narena = sc->tb.caparena = src->narena;

    scur c = {.sc = sc};
    const pl_tok *top = scur_next(&c);
    if (!top || top->kind != PL_BEGIN_OBJ) {
        scur_fail(&c, "schema: expected an object");
        goto fail;
    }
    // the slots, found by key
    size_t nodes_at = 0, ids_at = 0, commands_at = 0, events_at = 0, stores_at = 0;
    size_t p = 1;
    while (p < sc->tb.ntoks && sc->tb.toks[p].kind == PL_KEY) {
        size_t klen;
        const char *k = tok_span(&sc->tb, &sc->tb.toks[p], &klen);
        if (span_eq(k, klen, "nodes")) nodes_at = p + 1;
        else if (span_eq(k, klen, "ids")) ids_at = p + 1;
        else if (span_eq(k, klen, "commands")) commands_at = p + 1;
        else if (span_eq(k, klen, "eventTypes")) events_at = p + 1;
        else if (span_eq(k, klen, "storeTypes")) stores_at = p + 1;
        p = tok_skip(&sc->tb, p + 1);
    }
    if (!nodes_at || !ids_at || !commands_at || !events_at || !stores_at) {
        scur_fail(&c, "schema: missing nodes, ids, commands, eventTypes, or storeTypes");
        goto fail;
    }

    // the nodes
    c.pos = nodes_at;
    size_t nodes_end;
    long nnodes = scur_enter_arr(&c, &nodes_end);
    if (nnodes < 0) goto fail;
    sc->nodes = calloc((size_t)nnodes + 1, sizeof *sc->nodes);
    if (!sc->nodes) die("out of memory");
    sc->nnodes = (size_t)nnodes;
    for (long i = 0; i < nnodes; i++) {
        if (parse_node(&c, &sc->nodes[i])) goto fail;
    }

    // the identities
    c.pos = ids_at;
    const pl_tok *idsobj = scur_next(&c);
    if (!idsobj || idsobj->kind != PL_BEGIN_OBJ) {
        scur_fail(&c, "schema: ids must be an object");
        goto fail;
    }
    sc->ids = calloc(idsobj->num + 1, sizeof *sc->ids);
    if (!sc->ids) die("out of memory");
    while (c.pos < sc->tb.ntoks && sc->tb.toks[c.pos].kind == PL_KEY) {
        ident *id = &sc->ids[sc->nids];
        id->id = tok_span(&sc->tb, &sc->tb.toks[c.pos], &id->idlen);
        c.pos++;
        if (scur_type_index(&c, &id->idx)) goto fail;
        sc->nids++;
    }

    // the commands union, and the family and key maps
    c.pos = commands_at;
    const char *commands;
    if (scur_name(&c, &commands)) goto fail;
    if (commands) {
        size_t len = sc->tb.toks[commands_at].num;
        sc->commands = schema_lookup(sc, commands, len);
        if (sc->commands < 0) {
            scur_fail(&c, "schema: commands names an unknown type");
            goto fail;
        }
    }
    c.pos = events_at;
    if (parse_mappings(&c, &sc->event_types, &sc->nevent_types)) goto fail;
    c.pos = stores_at;
    if (parse_mappings(&c, &sc->store_types, &sc->nstore_types)) goto fail;
    if (c.failed) goto fail;
    return sc;

fail:
    snprintf(err, errlen, "%s", c.err[0] ? c.err : "schema: parse failed");
    schema_free(sc);
    return NULL;
}

long schema_lookup(const schema *sc, const char *id, size_t len) {
    for (size_t i = 0; i < sc->nids; i++) {
        if (sc->ids[i].idlen == len && memcmp(sc->ids[i].id, id, len) == 0) return sc->ids[i].idx;
    }
    return -1;
}

long schema_commands(const schema *sc) { return sc->commands; }

static long mapping_lookup(const schema *sc, const mapping *m, size_t n, const char *key, size_t keylen) {
    for (size_t i = 0; i < n; i++) {
        if (m[i].keylen == keylen && memcmp(m[i].key, key, keylen) == 0) {
            return schema_lookup(sc, m[i].value, m[i].valuelen);
        }
    }
    return -1;
}

long schema_event_type(const schema *sc, const char *stream) {
    const char *dot = strchr(stream, '.');
    size_t flen = dot ? (size_t)(dot - stream) : strlen(stream);
    return mapping_lookup(sc, sc->event_types, sc->nevent_types, stream, flen);
}

// sinks ////////////////////////////////////////////////////////////////////

/* A sink consumes the event sequence the walk emits for one value.  Each method returns 0, or
   -1 after recording why it failed. */

typedef struct sink sink;

typedef struct sink_vt {
    int (*begin_obj)(sink *s, size_t n);
    int (*key)(sink *s, const char *k, size_t len);
    int (*end_obj)(sink *s);
    int (*begin_arr)(sink *s, size_t n);
    int (*end_arr)(sink *s);
    int (*str)(sink *s, const char *v, size_t len);
    int (*int_)(sink *s, int64_t i);
    int (*float_)(sink *s, double f);
    int (*bool_)(sink *s, int b);
    int (*null_)(sink *s);
    int (*date)(sink *s, double ms);
} sink_vt;

struct sink {
    const sink_vt *vt;
    void *state;
    const char *fail; /* set when no exception explains the failure */
};

static int sink_fail(sink *s, const char *msg) {
    if (!s->fail) s->fail = msg;
    return -1;
}

// the null sink, for a check

static int nsink_n(sink *s, size_t n) { (void)s; (void)n; return 0; }
static int nsink_bytes(sink *s, const char *v, size_t len) { (void)s; (void)v; (void)len; return 0; }
static int nsink_0(sink *s) { (void)s; return 0; }
static int nsink_i(sink *s, int64_t i) { (void)s; (void)i; return 0; }
static int nsink_f(sink *s, double f) { (void)s; (void)f; return 0; }
static int nsink_b(sink *s, int b) { (void)s; (void)b; return 0; }

static const sink_vt nsink_vt = {nsink_n, nsink_bytes, nsink_0, nsink_n, nsink_0, nsink_bytes,
                                 nsink_i, nsink_f,     nsink_b, nsink_0, nsink_f};

// the JS heap

typedef struct jsframe {
    JSValue obj;
    bool is_arr;
    uint32_t idx;
    JSAtom key; /* the pending object key, or JS_ATOM_NULL */
} jsframe;

typedef struct jssink {
    JSContext *ctx;
    jsframe *stack;
    size_t depth, cap;
    JSValue result; /* JS_UNINITIALIZED until the top-level value is built */
} jssink;

/* attach a freshly built value (stolen) to the open container, or make it the result */
static int jssink_attach(sink *s, JSValue v) {
    jssink *j = s->state;
    JSContext *ctx = j->ctx;
    if (JS_IsException(v)) return -1;
    if (j->depth == 0) {
        if (!JS_IsUninitialized(j->result)) JS_FreeValue(ctx, j->result);
        j->result = v;
        return 0;
    }
    jsframe *f = &j->stack[j->depth - 1];
    if (f->is_arr) return JS_DefinePropertyValueUint32(ctx, f->obj, f->idx++, v, JS_PROP_C_W_E) < 0 ? -1 : 0;
    if (f->key == JS_ATOM_NULL) {
        JS_FreeValue(ctx, v);
        return sink_fail(s, "object value without a key");
    }
    int ret = JS_DefinePropertyValue(ctx, f->obj, f->key, v, JS_PROP_C_W_E);
    JS_FreeAtom(ctx, f->key);
    f->key = JS_ATOM_NULL;
    return ret < 0 ? -1 : 0;
}

static int jssink_push(sink *s, JSValue obj, bool is_arr) {
    jssink *j = s->state;
    if (JS_IsException(obj)) return -1;
    if (j->depth == j->cap) {
        size_t cap = j->cap ? j->cap * 2 : 32;
        jsframe *stack = realloc(j->stack, cap * sizeof *stack);
        if (!stack) die("out of memory");
        j->stack = stack;
        j->cap = cap;
    }
    j->stack[j->depth++] = (jsframe){.obj = obj, .is_arr = is_arr, .key = JS_ATOM_NULL};
    return 0;
}

static int jssink_pop(sink *s) {
    jssink *j = s->state;
    if (j->depth == 0) return sink_fail(s, "unbalanced container events");
    jsframe f = j->stack[--j->depth];
    if (f.key != JS_ATOM_NULL) JS_FreeAtom(j->ctx, f.key);
    return jssink_attach(s, f.obj);
}

static int jssink_begin_obj(sink *s, size_t n) {
    (void)n;
    jssink *j = s->state;
    return jssink_push(s, JS_NewObject(j->ctx), false);
}

static int jssink_key(sink *s, const char *k, size_t len) {
    jssink *j = s->state;
    if (j->depth == 0) return sink_fail(s, "key outside an object");
    jsframe *f = &j->stack[j->depth - 1];
    if (f->key != JS_ATOM_NULL) JS_FreeAtom(j->ctx, f->key);
    f->key = JS_NewAtomLen(j->ctx, k, len);
    return f->key == JS_ATOM_NULL ? -1 : 0;
}

static int jssink_end_obj(sink *s) { return jssink_pop(s); }

static int jssink_begin_arr(sink *s, size_t n) {
    (void)n;
    jssink *j = s->state;
    return jssink_push(s, JS_NewArray(j->ctx), true);
}

static int jssink_end_arr(sink *s) { return jssink_pop(s); }
static int jssink_str(sink *s, const char *v, size_t len) {
    jssink *j = s->state;
    return jssink_attach(s, JS_NewStringLen(j->ctx, v, len));
}
static int jssink_int(sink *s, int64_t i) {
    jssink *j = s->state;
    return jssink_attach(s, JS_NewInt64(j->ctx, i));
}
static int jssink_float(sink *s, double f) {
    jssink *j = s->state;
    return jssink_attach(s, JS_NewFloat64(j->ctx, f));
}
static int jssink_bool(sink *s, int b) { return jssink_attach(s, b ? JS_TRUE : JS_FALSE); }
static int jssink_null(sink *s) { return jssink_attach(s, JS_NULL); }
static int jssink_date(sink *s, double ms) {
    jssink *j = s->state;
    return jssink_attach(s, JS_NewDate(j->ctx, ms));
}

static const sink_vt jssink_vt = {jssink_begin_obj, jssink_key,  jssink_end_obj, jssink_begin_arr,
                                  jssink_end_arr,   jssink_str,  jssink_int,     jssink_float,
                                  jssink_bool,      jssink_null, jssink_date};

static void jssink_init(sink *s, jssink *j, JSContext *ctx) {
    memset(j, 0, sizeof *j);
    j->ctx = ctx;
    j->result = JS_UNINITIALIZED;
    *s = (sink){.vt = &jssink_vt, .state = j};
}

/* the built value, or JS_UNINITIALIZED if nothing complete was built */
static JSValue jssink_finish(sink *s) {
    jssink *j = s->state;
    for (size_t i = 0; i < j->depth; i++) {
        JS_FreeValue(j->ctx, j->stack[i].obj);
        if (j->stack[i].key != JS_ATOM_NULL) JS_FreeAtom(j->ctx, j->stack[i].key);
    }
    free(j->stack);
    JSValue out = j->result;
    memset(j, 0, sizeof *j);
    return out;
}

// an mpack writer

#define WSINK(name, ...)                                                                        \
    mpack_writer_t *w = s->state;                                                              \
    name(w, ##__VA_ARGS__);                                                                     \
    return mpack_writer_error(w) == mpack_ok ? 0 : sink_fail(s, "msgpack writer failed")

static int wsink_begin_obj(sink *s, size_t n) { WSINK(mpack_start_map, (uint32_t)n); }
static int wsink_key(sink *s, const char *k, size_t len) { WSINK(mpack_write_str, k, (uint32_t)len); }
static int wsink_end_obj(sink *s) { WSINK(mpack_finish_map); }
static int wsink_begin_arr(sink *s, size_t n) { WSINK(mpack_start_array, (uint32_t)n); }
static int wsink_end_arr(sink *s) { WSINK(mpack_finish_array); }
static int wsink_str(sink *s, const char *v, size_t len) { WSINK(mpack_write_str, v, (uint32_t)len); }
static int wsink_int(sink *s, int64_t i) { WSINK(mpack_write_i64, i); }
static int wsink_float(sink *s, double f) { WSINK(mpack_write_double, f); }
static int wsink_bool(sink *s, int b) { WSINK(mpack_write_bool, b != 0); }
static int wsink_null(sink *s) { WSINK(mpack_write_nil); }
static int wsink_date(sink *s, double ms) {
    int64_t total = (int64_t)floor(ms);
    int64_t sec = total / 1000;
    int64_t rem = total % 1000;
    if (rem < 0) {
        rem += 1000;
        sec -= 1;
    }
    WSINK(mpack_write_timestamp, sec, (uint32_t)(rem * 1000000));
}

static const sink_vt wsink_vt = {wsink_begin_obj, wsink_key,  wsink_end_obj, wsink_begin_arr,
                                 wsink_end_arr,   wsink_str,  wsink_int,     wsink_float,
                                 wsink_bool,      wsink_null, wsink_date};

// values ///////////////////////////////////////////////////////////////////

/* A value a walk reads: a node of a parsed msgpack tree, or the index of a token of a JS-heap
   tokenization, as the walk's source says. */
typedef struct val {
    mpack_node_t node;
    size_t tok;
} val;

/* Interprets the schema over a value and drives a sink.  The first mismatch ends the walk with
   an error that names the path. */
typedef struct walk {
    const pl_tokbuf *tb; /* the tokens read, or NULL for a msgpack tree */
    const schema *sc;
    sink *sink;
    bool strict;
    int depth;
    // the current path, as a byte buffer and a stack of segment lengths
    char path[1024];
    size_t pathlen;
    size_t seglens[MAX_DEPTH + 2];
    size_t nseg;
    // the prepared fields of the top-level value: collected by a check, written by a write
    intake_list *intakes;
    const intake_list *results;
    bool top;
    char *err;
    size_t errlen;
    bool failed;
} walk;

static void walk_fail(walk *w, const char *fmt, ...) {
    if (w->failed) return;
    w->failed = true;
    char msg[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    snprintf(w->err, w->errlen, "$%.*s: %s", (int)w->pathlen, w->path, msg);
}

static void path_push(walk *w, const char *fmt, ...) {
    char seg[128];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(seg, sizeof seg, fmt, ap);
    va_end(ap);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof seg) n = (int)sizeof seg - 1;
    if (w->pathlen + (size_t)n > sizeof w->path || w->nseg > MAX_DEPTH) n = 0;
    memcpy(w->path + w->pathlen, seg, (size_t)n);
    w->pathlen += (size_t)n;
    w->seglens[w->nseg++] = (size_t)n;
}

static void path_pop(walk *w) {
    if (w->nseg == 0) return;
    w->pathlen -= w->seglens[--w->nseg];
}

#define SINK(w, call)                                                                           \
    do {                                                                                        \
        if (!(w)->failed && (w)->sink->vt->call < 0) {                                          \
            walk_fail((w), "%s", (w)->sink->fail ? (w)->sink->fail : "the sink failed");        \
        }                                                                                       \
    } while (0)

/* the kind of a value: one of the token kinds, or PL_INVALID for one no type accepts (bin, an
   extension other than a timestamp, an integer past int64) */
static uint8_t v_kind(walk *w, val v) {
    if (w->tb) return w->tb->toks[v.tok].kind;
    switch (mpack_node_type(v.node)) {
    case mpack_type_nil: return PL_NULL;
    case mpack_type_bool: return PL_BOOL;
    case mpack_type_int: return PL_INT;
    case mpack_type_uint: return v.node.data->value.u > (uint64_t)INT64_MAX ? PL_INVALID : PL_INT;
    case mpack_type_float:
    case mpack_type_double: return PL_FLOAT;
    case mpack_type_str: return PL_STRING;
    case mpack_type_array: return PL_BEGIN_ARR;
    case mpack_type_map: return PL_BEGIN_OBJ;
    case mpack_type_ext: return mpack_node_exttype(v.node) == MPACK_EXTTYPE_TIMESTAMP ? PL_DATE : PL_INVALID;
    default: return PL_INVALID;
    }
}

/* what a value is, for an error */
static const char *v_name(walk *w, val v) {
    switch (v_kind(w, v)) {
    case PL_BEGIN_OBJ: return "an object";
    case PL_BEGIN_ARR: return "an array";
    case PL_STRING: return "a string";
    case PL_INT: return "an int";
    case PL_FLOAT: return "a float";
    case PL_BOOL: return "a bool";
    case PL_NULL: return "null";
    case PL_DATE: return "a timestamp";
    default: break;
    }
    if (w->tb) return "an invalid value";
    switch (mpack_node_type(v.node)) {
    case mpack_type_bin: return "a bin value";
    case mpack_type_ext: return "an extension other than a timestamp";
    case mpack_type_uint: return "an integer past int64";
    default: return "an invalid value";
    }
}

static int64_t v_int(walk *w, val v) {
    if (w->tb) return w->tb->toks[v.tok].i;
    return mpack_node_type(v.node) == mpack_type_uint ? (int64_t)v.node.data->value.u : v.node.data->value.i;
}

static double v_float(walk *w, val v) {
    if (w->tb) return w->tb->toks[v.tok].f;
    return mpack_node_double(v.node);
}

static bool v_bool(walk *w, val v) {
    if (w->tb) return w->tb->toks[v.tok].i != 0;
    return mpack_node_bool(v.node);
}

static const char *v_str(walk *w, val v, size_t *len) {
    if (w->tb) return tok_span(w->tb, &w->tb->toks[v.tok], len);
    *len = mpack_node_strlen(v.node);
    return mpack_node_str(v.node);
}

static uint64_t be(const uint8_t *p, int n) {
    uint64_t x = 0;
    for (int i = 0; i < n; i++) x = x << 8 | p[i];
    return x;
}

/* a timestamp's milliseconds since the epoch; false for a malformed timestamp extension */
static bool v_date(walk *w, val v, double *ms) {
    if (w->tb) {
        *ms = w->tb->toks[v.tok].f;
        return true;
    }
    // the extension's payload in any of its three sizes, checked here, since mpack's own accessor
    // flags an error that would end the whole tree
    const uint8_t *p = (const uint8_t *)mpack_node_data(v.node);
    int64_t sec;
    uint32_t nsec;
    switch (v.node.data->len) {
    case 4:
        sec = (int64_t)be(p, 4);
        nsec = 0;
        break;
    case 8: {
        uint64_t x = be(p, 8);
        nsec = (uint32_t)(x >> 34);
        sec = (int64_t)(x & 0x3ffffffffull);
        break;
    }
    case 12:
        nsec = (uint32_t)be(p, 4);
        sec = (int64_t)be(p + 4, 8);
        break;
    default: return false;
    }
    if (nsec > 999999999u) return false;
    *ms = (double)sec * 1000.0 + floor(nsec / 1e6);
    return true;
}

/* the element count of an array, or the entry count of a map */
static size_t v_count(walk *w, val v) {
    if (w->tb) return w->tb->toks[v.tok].num;
    if (mpack_node_type(v.node) == mpack_type_array) return mpack_node_array_length(v.node);
    return mpack_node_map_count(v.node);
}

/* an int, or a float with an integral value */
static bool v_integral(walk *w, val v, int64_t *out) {
    uint8_t k = v_kind(w, v);
    if (k == PL_INT) {
        *out = v_int(w, v);
        return true;
    }
    if (k != PL_FLOAT) return false;
    double f = v_float(w, v);
    if (!isfinite(f) || f != floor(f) || fabs(f) >= 9007199254740992.0) return false;
    *out = (int64_t)f;
    return true;
}

/* a walk over the children of an array or map */
typedef struct iter {
    size_t i, n, at;
} iter;

static iter it_begin(walk *w, val c) { return (iter){.i = 0, .n = v_count(w, c), .at = c.tok + 1}; }

static val it_elem(walk *w, val c, iter *it) {
    val v = {0};
    if (w->tb) {
        v.tok = it->at;
        it->at = tok_skip(w->tb, it->at);
    } else {
        v.node = mpack_node_array_at(c.node, it->i);
    }
    it->i++;
    return v;
}

/* the next entry of a map: its value, and its key, NULL when the key is not a string */
static val it_entry(walk *w, val c, iter *it, const char **key, size_t *keylen) {
    val v = {0};
    if (w->tb) {
        *key = tok_span(w->tb, &w->tb->toks[it->at], keylen);
        v.tok = it->at + 1;
        it->at = tok_skip(w->tb, it->at + 1);
    } else {
        mpack_node_t k = mpack_node_map_key_at(c.node, it->i);
        if (mpack_node_type(k) == mpack_type_str) {
            *keylen = mpack_node_strlen(k);
            *key = mpack_node_str(k);
        } else {
            *key = NULL;
            *keylen = 0;
        }
        v.node = mpack_node_map_value_at(c.node, it->i);
    }
    it->i++;
    return v;
}

/* the value of key in the map obj; false when it has none */
static bool find_field(walk *w, val obj, const char *key, size_t keylen, val *out) {
    iter it = it_begin(w, obj);
    while (it.i < it.n) {
        const char *k;
        size_t len;
        val v = it_entry(w, obj, &it, &k, &len);
        if (k && len == keylen && memcmp(k, key, len) == 0) {
            *out = v;
            return true;
        }
    }
    return false;
}

/* element n of the array arr; false when it has none */
static bool nth_elem(walk *w, val arr, int64_t n, val *out) {
    if (n < 0 || (size_t)n >= v_count(w, arr)) return false;
    iter it = it_begin(w, arr);
    val v = {0};
    for (int64_t i = 0; i <= n; i++) v = it_elem(w, arr, &it);
    *out = v;
    return true;
}

static uint8_t v_jsontype(walk *w, val v) {
    int64_t i;
    switch (v_kind(w, v)) {
    case PL_NULL: return JT_NULL;
    case PL_INT: return JT_INT;
    case PL_FLOAT: return v_integral(w, v, &i) ? JT_INT : JT_NONE;
    case PL_STRING:
    case PL_DATE: return JT_STRING;
    case PL_BOOL: return JT_BOOLEAN;
    case PL_BEGIN_OBJ: return JT_OBJECT;
    case PL_BEGIN_ARR: return JT_ARRAY;
    default: return JT_NONE;
    }
}

static bool v_matches_lit(walk *w, val v, const lit *l) {
    uint8_t k = v_kind(w, v);
    int64_t i;
    switch (l->kind) {
    case L_BOOL: return k == PL_BOOL && v_bool(w, v) == (l->i != 0);
    case L_INT: return v_integral(w, v, &i) && i == l->i;
    default: {
        if (k != PL_STRING) return false;
        size_t len;
        const char *s = v_str(w, v, &len);
        return len == l->slen && memcmp(s, l->s, len) == 0;
    }
    }
}

// the walk /////////////////////////////////////////////////////////////////

static void walk_value(walk *w, uint32_t type, val v);

/* a scalar, as it is */
static void walk_scalar(walk *w, val v) {
    size_t len;
    const char *s;
    double ms;
    switch (v_kind(w, v)) {
    case PL_NULL: SINK(w, null_(w->sink)); break;
    case PL_BOOL: SINK(w, bool_(w->sink, v_bool(w, v))); break;
    case PL_INT: SINK(w, int_(w->sink, v_int(w, v))); break;
    case PL_FLOAT: SINK(w, float_(w->sink, v_float(w, v))); break;
    case PL_STRING:
        s = v_str(w, v, &len);
        SINK(w, str(w->sink, s, len));
        break;
    case PL_DATE:
        if (!v_date(w, v, &ms)) walk_fail(w, "malformed timestamp");
        else SINK(w, date(w->sink, ms));
        break;
    default: walk_fail(w, "%s is not allowed", v_name(w, v));
    }
}

/* the schema-free walk: copy one value to the sink as it is */
static void walk_passthrough(walk *w, val v) {
    if (w->failed) return;
    if (++w->depth > MAX_DEPTH) {
        walk_fail(w, "nested too deeply");
        return;
    }
    uint8_t k = v_kind(w, v);
    if (k == PL_BEGIN_ARR) {
        iter it = it_begin(w, v);
        SINK(w, begin_arr(w->sink, it.n));
        while (it.i < it.n && !w->failed) {
            path_push(w, "[%zu]", it.i);
            walk_passthrough(w, it_elem(w, v, &it));
            path_pop(w);
        }
        SINK(w, end_arr(w->sink));
    } else if (k == PL_BEGIN_OBJ) {
        iter it = it_begin(w, v);
        SINK(w, begin_obj(w->sink, it.n));
        while (it.i < it.n && !w->failed) {
            const char *key;
            size_t len;
            val fv = it_entry(w, v, &it, &key, &len);
            if (!key) {
                walk_fail(w, "a map key is not a string");
                break;
            }
            SINK(w, key(w->sink, key, len));
            path_push(w, ".%.*s", (int)(len < 100 ? len : 100), key);
            walk_passthrough(w, fv);
            path_pop(w);
        }
        SINK(w, end_obj(w->sink));
    } else {
        walk_scalar(w, v);
    }
    w->depth--;
}

/* the prepared field of the top-level value under key, from the results being written */
static const intake *result_for(walk *w, const char *key, size_t keylen) {
    if (!w->results) return NULL;
    for (size_t i = 0; i < w->results->n; i++) {
        const intake *in = &w->results->v[i];
        if (strlen(in->key) == keylen && memcmp(in->key, key, keylen) == 0) return in;
    }
    return NULL;
}

static void walk_struct(walk *w, const node *n, val v) {
    if (v_kind(w, v) != PL_BEGIN_OBJ) {
        walk_fail(w, "expected an object, not %s", v_name(w, v));
        return;
    }
    bool top = w->top;
    w->top = false;
    size_t nf = n->nchildren;

    // find each declared field's value, and judge the rest
    val found[nf ? nf : 1];
    bool have[nf ? nf : 1];
    memset(have, 0, sizeof have);
    size_t present = 0;
    iter it = it_begin(w, v);
    while (it.i < it.n && !w->failed) {
        const char *k;
        size_t len;
        val fv = it_entry(w, v, &it, &k, &len);
        if (!k) {
            walk_fail(w, "a map key is not a string");
            break;
        }
        size_t i = 0;
        for (; i < nf; i++) {
            if (n->fields[i].keylen == len && memcmp(n->fields[i].key, k, len) == 0) break;
        }
        if (i == nf) {
            // a field the schema does not name
            if (w->strict) {
                path_push(w, ".%.*s", (int)(len < 100 ? len : 100), k);
                walk_fail(w, "unknown field");
                path_pop(w);
            }
        } else if (have[i]) {
            path_push(w, ".%.*s", (int)len, k);
            walk_fail(w, "repeated field");
            path_pop(w);
        } else {
            found[i] = fv;
            have[i] = true;
            present++;
        }
    }
    if (w->failed) return;

    // every required field is present
    for (size_t i = 0; i < nf; i++) {
        if (have[i] || n->fields[i].optional) continue;
        path_push(w, ".%.*s", (int)n->fields[i].keylen, n->fields[i].key);
        walk_fail(w, "missing required field");
        path_pop(w);
        return;
    }

    // emit them, the discriminator first and then declaration order
    SINK(w, begin_obj(w->sink, present));
    for (size_t k = 0; k < nf + 1 && !w->failed; k++) {
        size_t i;
        if (k == 0) {
            if (n->disc < 0) continue;
            i = (size_t)n->disc;
        } else {
            i = k - 1;
            if ((int)i == n->disc) continue;
        }
        const field *f = &n->fields[i];
        if (!have[i]) continue;
        path_push(w, ".%.*s", (int)f->keylen, f->key);
        SINK(w, key(w->sink, f->key, f->keylen));

        // a prepared field of the top-level value: collect it, or write its result in its place
        if (top && w->sc->nodes[f->type].kind == N_INTAKE) {
            if (w->intakes) {
                intake_list *il = w->intakes;
                if (il->n == il->cap) {
                    il->cap = il->cap ? il->cap * 2 : 4;
                    il->v = realloc(il->v, il->cap * sizeof *il->v);
                    if (!il->v) die("out of memory");
                }
                intake *in = &il->v[il->n++];
                memset(in, 0, sizeof *in);
                in->kind = w->sc->nodes[f->type].kind_name;
                snprintf(in->key, sizeof in->key, "%.*s", (int)f->keylen, f->key);
                in->node = found[i].node;
            }
            const intake *r = result_for(w, f->key, f->keylen);
            if (r && r->result) {
                SINK(w, str(w->sink, r->result, strlen(r->result)));
                path_pop(w);
                continue;
            }
        }
        walk_value(w, f->type, found[i]);
        path_pop(w);
    }
    SINK(w, end_obj(w->sink));
}

static void walk_record(walk *w, const node *n, val v) {
    if (v_kind(w, v) != PL_BEGIN_OBJ) {
        walk_fail(w, "expected an object, not %s", v_name(w, v));
        return;
    }
    iter it = it_begin(w, v);
    SINK(w, begin_obj(w->sink, it.n));
    while (it.i < it.n && !w->failed) {
        const char *k;
        size_t len;
        val fv = it_entry(w, v, &it, &k, &len);
        if (!k) {
            walk_fail(w, "a map key is not a string");
            break;
        }
        SINK(w, key(w->sink, k, len));
        path_push(w, ".%.*s", (int)(len < 100 ? len : 100), k);
        walk_value(w, n->child, fv);
        path_pop(w);
    }
    SINK(w, end_obj(w->sink));
}

static void walk_array(walk *w, const node *n, val v) {
    if (v_kind(w, v) != PL_BEGIN_ARR) {
        walk_fail(w, "expected an array, not %s", v_name(w, v));
        return;
    }
    iter it = it_begin(w, v);
    SINK(w, begin_arr(w->sink, it.n));
    while (it.i < it.n && !w->failed) {
        path_push(w, "[%zu]", it.i);
        walk_value(w, n->child, it_elem(w, v, &it));
        path_pop(w);
    }
    SINK(w, end_arr(w->sink));
}

static void walk_tuple(walk *w, const node *n, val v) {
    if (v_kind(w, v) != PL_BEGIN_ARR) {
        walk_fail(w, "expected an array, not %s", v_name(w, v));
        return;
    }
    size_t count = v_count(w, v);
    if (count != n->nchildren) {
        walk_fail(w, "expected %zu items, not %zu", n->nchildren, count);
        return;
    }
    iter it = it_begin(w, v);
    SINK(w, begin_arr(w->sink, count));
    while (it.i < it.n && !w->failed) {
        path_push(w, "[%zu]", it.i);
        uint32_t type = n->children[it.i];
        walk_value(w, type, it_elem(w, v, &it));
        path_pop(w);
    }
    SINK(w, end_arr(w->sink));
}

/* Evaluate a solution.  obj is the container being navigated, subj the value being tested,
   and root the union value itself, which a match walks in full. */
static void walk_solution(walk *w, const sol *s, val obj, val subj, val root) {
    if (w->failed) return;
    switch (s->kind) {
    case S_MATCH:
        walk_value(w, s->type, root);
        return;
    case S_JSONTYPE: {
        uint8_t jt = v_jsontype(w, subj);
        const sol *any = NULL;
        for (size_t i = 0; i < s->nopts; i++) {
            if (s->opts[i].jt == jt) {
                walk_solution(w, s->opts[i].sol, obj, subj, root);
                return;
            }
            if (s->opts[i].jt == JT_ANY) any = s->opts[i].sol;
        }
        if (any) {
            walk_solution(w, any, obj, subj, root);
            return;
        }
        walk_fail(w, "%s is not allowed here", v_name(w, subj));
        return;
    }
    case S_LITERAL:
        for (size_t i = 0; i < s->nopts; i++) {
            if (v_matches_lit(w, subj, &s->opts[i].lit)) {
                walk_solution(w, s->opts[i].sol, obj, subj, root);
                return;
            }
        }
        if (v_kind(w, subj) == PL_STRING) {
            size_t len;
            const char *str = v_str(w, subj, &len);
            walk_fail(w, "unexpected value \"%.*s\"", (int)(len < 100 ? len : 100), str);
        } else {
            walk_fail(w, "unexpected value");
        }
        return;
    case S_LENGTH: {
        if (v_kind(w, subj) != PL_BEGIN_ARR) {
            walk_fail(w, "expected an array, not %s", v_name(w, subj));
            return;
        }
        size_t len = v_count(w, subj);
        for (size_t i = 0; i < s->nopts; i++) {
            if (s->opts[i].length == (int64_t)len) {
                walk_solution(w, s->opts[i].sol, obj, subj, root);
                return;
            }
        }
        if (s->dflt) {
            walk_solution(w, s->dflt, obj, subj, root);
            return;
        }
        walk_fail(w, "unexpected length %zu", len);
        return;
    }
    case S_INDEX: {
        val elem;
        if (v_kind(w, subj) != PL_BEGIN_ARR || !nth_elem(w, subj, s->index, &elem)) {
            walk_fail(w, "missing index %lld", (long long)s->index);
            return;
        }
        walk_solution(w, s->sub, elem, elem, root);
        return;
    }
    case S_FIELD: {
        val fv;
        if (v_kind(w, obj) != PL_BEGIN_OBJ || !find_field(w, obj, s->key, s->keylen, &fv)) {
            walk_fail(w, "missing discriminator \"%.*s\"", (int)s->keylen, s->key);
            return;
        }
        walk_solution(w, s->sub, obj, fv, root);
        return;
    }
    case S_HASFIELD: {
        if (v_kind(w, obj) == PL_BEGIN_OBJ) {
            for (size_t i = 0; i < s->nopts; i++) {
                val fv;
                if (find_field(w, obj, s->opts[i].key, s->opts[i].keylen, &fv)) {
                    walk_solution(w, s->opts[i].sol, obj, obj, root);
                    return;
                }
            }
        }
        walk_fail(w, "none of the fields a member needs is present");
        return;
    }
    default: walk_fail(w, "corrupt solution");
    }
}

static void walk_value(walk *w, uint32_t type, val v) {
    if (w->failed) return;
    if (++w->depth > MAX_DEPTH) {
        walk_fail(w, "nested too deeply");
        return;
    }
    const node *n = &w->sc->nodes[type];
    uint8_t k = v_kind(w, v);
    int64_t i;
    switch (n->kind) {
    case N_NULL:
        if (k != PL_NULL) walk_fail(w, "expected null, not %s", v_name(w, v));
        else walk_scalar(w, v);
        break;
    case N_INT:
        if (!v_integral(w, v, &i)) walk_fail(w, "expected an int, not %s", v_name(w, v));
        else SINK(w, int_(w->sink, i));
        break;
    case N_STR:
        if (k != PL_STRING) walk_fail(w, "expected a string, not %s", v_name(w, v));
        else walk_scalar(w, v);
        break;
    case N_BOOL:
        if (k != PL_BOOL) walk_fail(w, "expected a bool, not %s", v_name(w, v));
        else walk_scalar(w, v);
        break;
    case N_DATE:
        if (k != PL_DATE) walk_fail(w, "expected a timestamp, not %s", v_name(w, v));
        else walk_scalar(w, v);
        break;
    case N_JSON:
        w->depth--;
        walk_passthrough(w, v);
        w->depth++;
        break;
    case N_LIT:
        if (!v_matches_lit(w, v, &n->lit)) {
            if (n->lit.kind == L_STR) walk_fail(w, "expected \"%.*s\"", (int)n->lit.slen, n->lit.s);
            else if (n->lit.kind == L_BOOL) walk_fail(w, "expected %s", n->lit.i ? "true" : "false");
            else walk_fail(w, "expected %lld", (long long)n->lit.i);
        } else if (n->lit.kind == L_INT) {
            SINK(w, int_(w->sink, n->lit.i));
        } else {
            walk_scalar(w, v);
        }
        break;
    case N_STRUCT: walk_struct(w, n, v); break;
    case N_RECORD: walk_record(w, n, v); break;
    case N_ARRAY: walk_array(w, n, v); break;
    case N_TUPLE: walk_tuple(w, n, v); break;
    case N_UNION: walk_solution(w, n->sol, v, v, v); break;
    case N_INTAKE: walk_value(w, n->child, v); break;
    default: walk_fail(w, "corrupt schema");
    }
    w->depth--;
}

/* run one walk over v; type < 0 selects the untyped copy */
static int walk_run(walk *w, val v, long type) {
    w->top = true;
    if (type < 0) walk_passthrough(w, v);
    else walk_value(w, (uint32_t)type, v);
    return w->failed ? -1 : 0;
}

static void walk_init(walk *w, const schema *sc, const pl_tokbuf *tb, sink *s, bool strict, char *err,
                      size_t errlen) {
    memset(w, 0, sizeof *w);
    w->sc = sc;
    w->tb = tb;
    w->sink = s;
    w->strict = strict;
    w->err = err;
    w->errlen = errlen;
}

void intake_list_free(intake_list *l) {
    for (size_t i = 0; i < l->n; i++) free(l->v[i].result);
    free(l->v);
    memset(l, 0, sizeof *l);
}

int walk_check(const schema *sc, mpack_node_t node, long type, bool strict, intake_list *il,
               char *err, size_t errlen) {
    sink s = {.vt = &nsink_vt};
    walk w;
    walk_init(&w, sc, NULL, &s, strict, err, errlen);
    w.intakes = il;
    return walk_run(&w, (val){.node = node}, type);
}

int walk_write(const schema *sc, mpack_node_t node, long type, bool strict, const intake_list *il,
               mpack_writer_t *out, char *err, size_t errlen) {
    sink s = {.vt = &wsink_vt, .state = out};
    walk w;
    walk_init(&w, sc, NULL, &s, strict, err, errlen);
    w.results = il;
    return walk_run(&w, (val){.node = node}, type);
}

JSValue walk_to_js(JSContext *ctx, const schema *sc, mpack_node_t node, long type, bool strict,
                   char *err, size_t errlen) {
    sink s;
    jssink js;
    jssink_init(&s, &js, ctx);
    walk w;
    walk_init(&w, sc, NULL, &s, strict, err, errlen);
    int rc = walk_run(&w, (val){.node = node}, type);
    JSValue out = jssink_finish(&s);
    if (rc) {
        if (!JS_IsUninitialized(out)) JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    return out;
}

int walk_to_mpack(jsenv *env, const schema *sc, JSValueConst v, long type, bool strict, buf *out,
                  char *err, size_t errlen) {
    pl_tokbuf tb = {0};
    if (jstok_tokenize(env, v, &tb, err, errlen)) {
        tb_free(&tb);
        return -1;
    }
    char *data = NULL;
    size_t size = 0;
    mpack_writer_t mw;
    mpack_writer_init_growable(&mw, &data, &size);
    sink s = {.vt = &wsink_vt, .state = &mw};
    walk w;
    walk_init(&w, sc, &tb, &s, strict, err, errlen);
    int rc = walk_run(&w, (val){.tok = 0}, type);
    if (mpack_writer_destroy(&mw) != mpack_ok && rc == 0) {
        snprintf(err, errlen, "msgpack encode failed");
        rc = -1;
    }
    if (rc == 0) buf_append(out, data, size);
    free(data);
    tb_free(&tb);
    return rc;
}
