/* The QuickJS host: loads host.js and the bundle, compiles the bundle's registry, exposes
   the store natives, which convert every value through it, and calls the bundle's slots
   through __host. */

#include <errno.h>
#include <sys/random.h>

#include "internal.h"
#include "host_js.h"

static jsrt *rt_of(JSContext *ctx) { return JS_GetContextOpaque(ctx); }

/* a stack with its frames in the bundle mapped through the bundle's source map, or the stack as
   it is when the bundle has no map or the mapping throws; takes stack */
static JSValue map_stack(jsrt *js, JSValue stack) {
    JSContext *ctx = js->ctx;
    if (!JS_IsFunction(ctx, js->map_stack) || !JS_IsObject(js->source_map)) return stack;
    JSValue args[3] = {stack, JS_NewString(ctx, js->bundle_file), js->source_map};
    JSValue mapped = JS_Call(ctx, js->map_stack, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, args[1]);
    if (JS_IsException(mapped)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return stack;
    }
    JS_FreeValue(ctx, stack);
    return mapped;
}

/* format the pending exception into js->err */
static void capture_exception(jsrt *js) {
    JSContext *ctx = js->ctx;
    JSValue exc = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, exc);
    const char *stack = NULL;
    JSValue st = JS_UNDEFINED;
    if (JS_IsError(ctx, exc)) {
        st = JS_GetPropertyStr(ctx, exc, "stack");
        if (!JS_IsUndefined(st)) st = map_stack(js, st);
        if (!JS_IsUndefined(st)) stack = JS_ToCString(ctx, st);
    }
    snprintf(js->err, sizeof js->err, "%s%s%s", msg ? msg : "exception", stack ? "\n" : "",
             stack ? stack : "");
    if (msg) JS_FreeCString(ctx, msg);
    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, st);
    JS_FreeValue(ctx, exc);
}

/* a name (a key, a stream, a variable) as a C string, or NULL with an exception; *nul says the
   name holds U+0000, where the C string stops short */
static char *name_arg(JSContext *ctx, JSValueConst v, bool *nul) {
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, v);
    if (!s) return NULL;
    *nul = strlen(s) != len;
    char *k = xstrdup(s);
    JS_FreeCString(ctx, s);
    return k;
}

/* the node of the type a call names; throws for one the registry does not know */
static long type_arg(JSContext *ctx, jsrt *js, JSValueConst v) {
    size_t len;
    const char *id = JS_ToCStringLen(ctx, &len, v);
    if (!id) return -1;
    long type = schema_lookup(js->sc, id, len);
    if (type < 0) JS_ThrowTypeError(ctx, "no registry entry for type %s", id);
    JS_FreeCString(ctx, id);
    return type;
}

/* the rich JS value of a stored value */
static JSValue decode_stored(JSContext *ctx, jsrt *js, const char *key, long type, const uint8_t *val,
                             size_t len) {
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char *)val, len);
    mpack_tree_parse(&tree);
    if (mpack_tree_error(&tree) != mpack_ok || mpack_tree_size(&tree) != len) {
        mpack_tree_destroy(&tree);
        return JS_ThrowTypeError(ctx, "stored value at %s: malformed msgpack", key);
    }
    char err[512];
    JSValue v = walk_to_js(ctx, js->sc, mpack_tree_root(&tree), type, false, err, sizeof err);
    mpack_tree_destroy(&tree);
    if (JS_IsException(v) && !JS_HasException(ctx)) {
        return JS_ThrowTypeError(ctx, "stored value at %s: %s", key, err);
    }
    return v;
}

static JSValue native_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    bool nul;
    char *key = name_arg(ctx, argv[0], &nul);
    if (!key) return JS_EXCEPTION;

    // no stored key holds U+0000, so a key that does is absent rather than read short
    if (nul) {
        free(key);
        return JS_UNDEFINED;
    }
    long type = type_arg(ctx, js, argv[1]);
    if (type < 0) {
        free(key);
        return JS_EXCEPTION;
    }
    if (js->track_rkeys) strlist_push(js->track_rkeys, key);
    uint8_t *val;
    size_t len;
    int rc = store_get(js->st, key, &val, &len);
    if (rc < 0) {
        JSValue e = JS_ThrowInternalError(ctx, "store get %s: %s", key, store_err(js->st));
        free(key);
        return e;
    }
    JSValue v = JS_UNDEFINED;
    if (rc > 0) {
        v = decode_stored(ctx, js, key, type, val, len);
        free(val);
    }
    free(key);
    return v;
}

/* whether a reducer may write key: only a reducer writes, and only to a key that holds no control
   character or lone surrogate and fills one of its slice's key templates; throws when not.  nul
   says the key holds U+0000 where the C string stops. */
static bool key_writable(JSContext *ctx, jsrt *js, const char *key, bool nul) {
    if (nul) {
        JS_ThrowTypeError(ctx, "a key beginning %s holds U+0000", key);
        return false;
    }
    if (!key_chars_ok(key)) {
        JS_ThrowTypeError(ctx, "key %s holds a control character or a lone surrogate", key);
        return false;
    }
    const slice_names *sl = js->reducing;
    if (sl && strlen(key) >= js->reducing_skip && key_fills(sl, key + js->reducing_skip)) return true;
    JS_ThrowTypeError(ctx, "key %s fills none of its slice's key templates", key);
    return false;
}

static JSValue native_set(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    bool nul;
    char *key = name_arg(ctx, argv[0], &nul);
    if (!key) return JS_EXCEPTION;
    if (!key_writable(ctx, js, key, nul)) {
        free(key);
        return JS_EXCEPTION;
    }
    long type = type_arg(ctx, js, argv[1]);
    if (type < 0) {
        free(key);
        return JS_EXCEPTION;
    }
    buf b = {0};
    char err[512];
    if (walk_to_mpack(&js->env, js->sc, argv[2], type, false, &b, err, sizeof err)) {
        JSValue e = JS_ThrowTypeError(ctx, "value for %s: %s", key, err);
        free(key);
        buf_free(&b);
        return e;
    }
    int rc = store_set(js->st, key, b.p, b.len);
    buf_free(&b);
    if (rc) {
        JSValue e = JS_ThrowInternalError(ctx, "store set %s: %s", key, store_err(js->st));
        free(key);
        return e;
    }
    if (js->track_wkeys) strlist_push(js->track_wkeys, key);
    free(key);
    return JS_UNDEFINED;
}

static JSValue native_del(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    bool nul;
    char *key = name_arg(ctx, argv[0], &nul);
    if (!key) return JS_EXCEPTION;
    if (!key_writable(ctx, js, key, nul)) {
        free(key);
        return JS_EXCEPTION;
    }
    if (store_del(js->st, key)) {
        JSValue e = JS_ThrowInternalError(ctx, "store del %s: %s", key, store_err(js->st));
        free(key);
        return e;
    }
    if (js->track_wkeys) strlist_push(js->track_wkeys, key);
    free(key);
    return JS_UNDEFINED;
}

/* one scan batch as it is collected: the entries the walk visits up to the batch's limit, and
   whether one more follows */
typedef struct batch_ctx {
    JSContext *ctx;
    jsrt *js;
    long type; // the values' type, or -1 for keys only
    size_t limit;
    JSValue entries;
    size_t n;
    bool more;
    char *last; // the batch's last key
    size_t last_n;
} batch_ctx;

/* take a key into the batch with its value, or note that more follow a full batch */
static int batch_visit(void *arg, const char *key, size_t n) {
    batch_ctx *b = arg;
    if (b->n == b->limit) {
        b->more = true;
        return 0;
    }

    // the key's value, decoded under the batch's type
    JSValue v = JS_UNDEFINED;
    if (b->type >= 0) {
        size_t len;
        const uint8_t *val = store_cursor_value(b->js->st, &len);
        v = decode_stored(b->ctx, b->js, key, b->type, val, len);
        if (JS_IsException(v)) return -1;
    }

    // the entry, and the key the batch would end with
    JSValue pair = JS_NewArray(b->ctx);
    JS_DefinePropertyValueUint32(b->ctx, pair, 0, JS_NewStringLen(b->ctx, key, n), JS_PROP_C_W_E);
    JS_DefinePropertyValueUint32(b->ctx, pair, 1, v, JS_PROP_C_W_E);
    JS_DefinePropertyValueUint32(b->ctx, b->entries, (uint32_t)b->n++, pair, JS_PROP_C_W_E);
    free(b->last);
    b->last = xmalloc(n + 1);
    memcpy(b->last, key, n);
    b->last[n] = 0;
    b->last_n = n;
    return 1;
}

/* the text of a request's after, its length in *n, or NULL for none; *failed says it threw */
static char *after_arg(JSContext *ctx, JSValueConst req, size_t *n, bool *failed) {
    JSValue v = JS_GetPropertyStr(ctx, req, "after");
    *failed = JS_IsException(v);
    if (*failed || JS_IsUndefined(v) || JS_IsNull(v)) return NULL;
    const char *s = JS_ToCStringLen(ctx, n, v);
    JS_FreeValue(ctx, v);
    if (!s) {
        *failed = true;
        return NULL;
    }
    char *out = xmalloc(*n + 1);
    memcpy(out, s, *n + 1);
    JS_FreeCString(ctx, s);
    return out;
}

/* One batch of a walk of the keys a pattern picks out, the skeleton's ReadScan answered with
   {entries, next}: the keys from just past after, with their values decoded under the type the
   request names, or keys only for a type of false.  It reads one key past the batch to tell
   whether more follow.  While maySee runs, the batch's span is its read-set. */
static JSValue native_scan(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    JSValueConst req = argv[0];
    if (!JS_IsObject(req)) return JS_ThrowTypeError(ctx, "a scan's request is an object");

    // the pattern, compiled
    JSValue pv = JS_GetPropertyStr(ctx, req, "pattern");
    pattern *p = JS_IsException(pv) ? NULL : pattern_from_js(ctx, pv);
    JS_FreeValue(ctx, pv);
    if (!p) return JS_EXCEPTION;

    // keys only, or values of the type it names, which one local template's keys share
    batch_ctx b = {ctx, js, -1, 0, JS_UNDEFINED, 0, false, NULL, 0};
    JSValue tv = JS_GetPropertyStr(ctx, req, "type");
    bool values = !(JS_IsBool(tv) && !JS_ToBool(ctx, tv));
    if (values && !pattern_named(p)) {
        JSValue e = JS_NewError(ctx);
        const char *msg = "a scan of every local key reads keys only";
        JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, msg));
        JS_Throw(ctx, e);
    } else if (values) {
        b.type = type_arg(ctx, js, tv);
    }
    JS_FreeValue(ctx, tv);
    if (values && b.type < 0) {
        pattern_free(p);
        return JS_EXCEPTION;
    }

    // its direction, where it resumes, and the batch's size
    JSValue rv = JS_GetPropertyStr(ctx, req, "reverse");
    bool reverse = JS_IsBool(rv) && JS_ToBool(ctx, rv);
    JS_FreeValue(ctx, rv);
    size_t after_n = 0;
    bool failed;
    char *after = after_arg(ctx, req, &after_n, &failed);
    JSValue lv = JS_GetPropertyStr(ctx, req, "limit");
    double limit = 0;
    if (!failed && JS_ToFloat64(ctx, &limit, lv)) failed = true;
    JS_FreeValue(ctx, lv);
    if (!failed && !(limit >= 1)) {
        JS_ThrowRangeError(ctx, "a scan's limit is at least 1");
        failed = true;
    }
    if (failed) {
        free(after);
        pattern_free(p);
        return JS_EXCEPTION;
    }
    b.limit = limit >= (double)SIZE_MAX ? SIZE_MAX : (size_t)limit;

    // walk one key past the batch, to tell whether more follow
    b.entries = JS_NewArray(ctx);
    if (pattern_walk(js->st, p, reverse, after, after_n, js->scan_budget, batch_visit, &b)) {
        if (!JS_HasException(ctx)) JS_ThrowInternalError(ctx, "store scan: %s", store_err(js->st));
        JS_FreeValue(ctx, b.entries);
        free(b.last);
        free(after);
        pattern_free(p);
        return JS_EXCEPTION;
    }

    // the batch, and what it walked for maySee's read-set
    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "entries", b.entries);
    JS_SetPropertyStr(ctx, out, "next", b.more ? JS_NewStringLen(ctx, b.last, b.last_n) : JS_NULL);
    if (js->track_spans) {
        const char *to = b.more ? b.last : NULL;
        span_list_push(js->track_spans, p, reverse, after, after_n, to, b.last_n);
    } else {
        pattern_free(p);
    }
    free(b.last);
    free(after);
    return out;
}

/* bootstrap's hashPassword: the hash intake would make */
static JSValue native_hash(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    size_t len;
    const char *pw = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!pw) return JS_EXCEPTION;
    char hash[512];
    int rc = js->hasher ? js->hasher(0, pw, len, hash, sizeof hash) : PLDB_HASH_FAILED;
    JS_FreeCString(ctx, pw);
    if (rc != PLDB_HASH_OK) return JS_ThrowInternalError(ctx, "password hashing failed");
    return JS_NewString(ctx, hash);
}

/* bootstrap's env: a variable the operator named, or "" for any other or an unset one */
static JSValue native_env(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    jsrt *js = rt_of(ctx);
    bool nul;
    char *name = name_arg(ctx, argv[0], &nul);
    if (!name) return JS_EXCEPTION;
    const char *v = !nul && strlist_has(&js->env_names, name) ? getenv(name) : NULL;
    free(name);
    return JS_NewString(ctx, v ? v : "");
}

/* __pl_random(n): an ArrayBuffer of n bytes from the kernel's CSPRNG, the source of the host's
   crypto.getRandomValues; n is at most 65536, as the Web Crypto API allows */
static JSValue native_random(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t n;
    if (JS_ToInt32(ctx, &n, argv[0])) return JS_EXCEPTION;
    if (n < 0 || n > 65536) {
        return JS_ThrowRangeError(ctx, "random bytes: %d is not in 0..65536", n);
    }
    uint8_t *buf = xmalloc((size_t)n + 1);
    for (int32_t got = 0; got < n;) {
        ssize_t r = getrandom(buf + got, (size_t)(n - got), 0);
        if (r < 0) {
            if (errno == EINTR) continue;
            free(buf);
            return JS_ThrowInternalError(ctx, "getrandom: %s", strerror(errno));
        }
        got += (int32_t)r;
    }
    JSValue out = JS_NewArrayBufferCopy(ctx, buf, (size_t)n);
    free(buf);
    return out;
}

static JSValue native_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    fprintf(stderr, "bundle:");
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        fprintf(stderr, " %s", s ? s : "?");
        if (s) JS_FreeCString(ctx, s);
    }
    fprintf(stderr, "\n");
    return JS_UNDEFINED;
}

static int eval_text(jsrt *js, const char *text, size_t len, const char *name) {
    /* JS_Eval wants its input NUL-terminated */
    buf b = {0};
    buf_append(&b, text, len);
    buf_append(&b, "", 1);
    JSValue r = JS_Eval(js->ctx, (const char *)b.p, b.len - 1, name, JS_EVAL_TYPE_GLOBAL);
    buf_free(&b);
    if (JS_IsException(r)) {
        capture_exception(js);
        return -1;
    }
    JS_FreeValue(js->ctx, r);
    return 0;
}

/* base64 text decoded and appended to out; false on a character outside the alphabet */
static bool base64_decode(const char *s, size_t n, buf *out) {
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        uint32_t v;
        switch (s[i]) {
        case 'A' ... 'Z': v = (uint32_t)(s[i] - 'A'); break;
        case 'a' ... 'z': v = (uint32_t)(s[i] - 'a' + 26); break;
        case '0' ... '9': v = (uint32_t)(s[i] - '0' + 52); break;
        case '+': v = 62; break;
        case '/': v = 63; break;
        case '=': return true;
        default: return false;
        }
        acc = (acc << 6 | v) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            uint8_t byte = (uint8_t)(acc >> bits);
            buf_append(out, &byte, 1);
        }
    }
    return true;
}

/* the source map a bundle carries inline, as its last sourceMappingURL comment, parsed into
   js->source_map; a bundle without one leaves it undefined */
static void load_source_map(jsrt *js, const char *text, size_t len) {
    static const char MARK[] = "//# sourceMappingURL=data:application/json;base64,";
    size_t m = sizeof MARK - 1;

    // the last comment, and the base64 that runs to the end of its line
    const char *found = NULL;
    for (size_t i = len >= m ? len - m + 1 : 0; i-- > 0;) {
        if (memcmp(text + i, MARK, m) == 0) {
            found = text + i + m;
            break;
        }
    }
    if (!found) return;
    const char *end = found;
    while (end < text + len && *end != '\n' && *end != '\r') end++;

    // decoded and parsed; a map that will not parse is reported and left out
    buf json = {0};
    bool ok = base64_decode(found, (size_t)(end - found), &json);
    buf_append(&json, "", 1);
    JSValue map = ok ? JS_ParseJSON(js->ctx, (const char *)json.p, json.len - 1, "sourcemap")
                     : JS_EXCEPTION;
    buf_free(&json);
    if (JS_IsException(map) || !JS_IsObject(map)) {
        if (JS_IsException(map)) JS_FreeValue(js->ctx, JS_GetException(js->ctx));
        else JS_FreeValue(js->ctx, map);
        fprintf(stderr, "pldb: the bundle's source map is malformed; stacks stay unmapped\n");
        return;
    }
    js->source_map = map;
}

/* evaluate the bundle at path, then load the source map it carries */
static int eval_bundle(jsrt *js, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(js->err, sizeof js->err, "open %s: %s", path, strerror(errno));
        return -1;
    }
    buf b = {0};
    char chunk[65536];
    size_t n;
    while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) buf_append(&b, chunk, n);
    fclose(f);
    int rc = eval_text(js, (const char *)b.p, b.len, path);
    if (!rc) load_source_map(js, (const char *)b.p, b.len);
    buf_free(&b);
    return rc;
}

/* the bundle's registry, compiled from the schema it installed */
static int load_schema(jsrt *js, JSValueConst bundle, char *err, size_t errlen) {
    JSContext *ctx = js->ctx;
    JSValue schema = JS_GetPropertyStr(ctx, bundle, "schema");
    if (!JS_IsObject(schema)) {
        JS_FreeValue(ctx, schema);
        snprintf(err, errlen, "bundle has no schema");
        return -1;
    }
    char why[512];
    pl_tokbuf tb = {0};
    int rc = jstok_tokenize(&js->env, schema, &tb, why, sizeof why);
    JS_FreeValue(ctx, schema);
    if (rc == 0) {
        js->sc = schema_compile(&tb, why, sizeof why);
        if (!js->sc) rc = -1;
    }
    tb_free(&tb);
    if (rc) snprintf(err, errlen, "bundle schema: %s", why);
    return rc;
}

static int strings_of(jsrt *js, JSValueConst arr, strlist *out);

/* every reducer's templates, from the bundle's SliceReducers; a template must name its own
   family */
static int load_slices(jsrt *js, JSValueConst bundle, char *err, size_t errlen) {
    JSContext *ctx = js->ctx;
    JSValue reducers = JS_GetPropertyStr(ctx, bundle, "reducers");
    JSPropertyEnum *tab = NULL;
    uint32_t n = 0;
    if (!JS_IsObject(reducers) ||
        JS_GetOwnPropertyNames(ctx, &tab, &n, reducers, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, reducers);
        snprintf(err, errlen, "bundle has no reducers");
        return -1;
    }
    js->slices = calloc(n ? n : 1, sizeof *js->slices);
    if (!js->slices) die("out of memory");

    // each reducer's family template and key templates
    int rc = 0;
    for (uint32_t i = 0; i < n && !rc; i++) {
        slice_names *sl = &js->slices[js->nslices++];
        const char *family = JS_AtomToCString(ctx, tab[i].atom);
        sl->family = xstrdup(family ? family : "");
        if (family) JS_FreeCString(ctx, family);
        JSValue slice = JS_GetProperty(ctx, reducers, tab[i].atom);
        JSValue tpl = JS_GetPropertyStr(ctx, slice, "template");
        JSValue keys = JS_GetPropertyStr(ctx, slice, "keys");
        const char *t = JS_IsString(tpl) ? JS_ToCString(ctx, tpl) : NULL;
        if (t) sl->stream = xstrdup(t);
        if (!t || JS_IsArray(ctx, keys) != 1 || strings_of(js, keys, &sl->keys)) {
            snprintf(err, errlen, "bundle reducer %s has no template or key templates", sl->family);
            rc = -1;
        } else if (slice_of(js, sl->stream) != sl) {
            snprintf(err, errlen, "bundle reducer %s has the template %s", sl->family, sl->stream);
            rc = -1;
        }
        if (t) JS_FreeCString(ctx, t);
        JS_FreeValue(ctx, keys);
        JS_FreeValue(ctx, tpl);
        JS_FreeValue(ctx, slice);
    }
    JS_FreePropertyEnum(ctx, tab, n);
    JS_FreeValue(ctx, reducers);
    return rc;
}

/* what a bundle expects of its environment and QuickJS lacks */
static const char ENV_SHIM[] =
    "if (typeof globalThis.process === 'undefined') {"
    "  globalThis.process = { env: { NODE_ENV: 'production' } };"
    "}";

int js_open(jsrt *js, const char *bundle_path, store *st, char *err, size_t errlen) {
    memset(js, 0, sizeof *js);
    js->st = st;
    js->scan_budget = SCAN_STEP_BUDGET;
    js->source_map = JS_UNDEFINED;
    js->map_stack = JS_UNDEFINED;
    js->bundle_file = xstrdup(bundle_path);
    js->rt = JS_NewRuntime();
    js->ctx = JS_NewContext(js->rt);
    JS_SetContextOpaque(js->ctx, js);
    JSValue global = JS_GetGlobalObject(js->ctx);
    JS_SetPropertyStr(js->ctx, global, "__pl_get", JS_NewCFunction(js->ctx, native_get, "__pl_get", 2));
    JS_SetPropertyStr(js->ctx, global, "__pl_set", JS_NewCFunction(js->ctx, native_set, "__pl_set", 3));
    JS_SetPropertyStr(js->ctx, global, "__pl_del", JS_NewCFunction(js->ctx, native_del, "__pl_del", 1));
    JS_SetPropertyStr(js->ctx, global, "__pl_scan", JS_NewCFunction(js->ctx, native_scan, "__pl_scan", 1));
    JS_SetPropertyStr(js->ctx, global, "__pl_hash", JS_NewCFunction(js->ctx, native_hash, "__pl_hash", 1));
    JS_SetPropertyStr(js->ctx, global, "__pl_env", JS_NewCFunction(js->ctx, native_env, "__pl_env", 1));
    JS_SetPropertyStr(js->ctx, global, "__pl_random",
                      JS_NewCFunction(js->ctx, native_random, "__pl_random", 1));
    JSValue console = JS_NewObject(js->ctx);
    JS_SetPropertyStr(js->ctx, console, "log", JS_NewCFunction(js->ctx, native_log, "log", 1));
    JS_SetPropertyStr(js->ctx, global, "console", console);

    if (jsenv_init(&js->env, js->ctx)) {
        capture_exception(js);
        snprintf(err, errlen, "js environment: %s", js->err);
        JS_FreeValue(js->ctx, global);
        return -1;
    }
    if (eval_text(js, ENV_SHIM, sizeof ENV_SHIM - 1, "<env>") ||
        eval_text(js, (const char *)host_js, host_js_len, "host.js")) {
        snprintf(err, errlen, "host.js: %s", js->err);
        JS_FreeValue(js->ctx, global);
        return -1;
    }
    if (eval_bundle(js, bundle_path)) {
        snprintf(err, errlen, "bundle: %s", js->err);
        JS_FreeValue(js->ctx, global);
        return -1;
    }
    JSValue bundle = JS_GetPropertyStr(js->ctx, global, "__bundle");
    js->host = JS_GetPropertyStr(js->ctx, global, "__host");
    JS_FreeValue(js->ctx, global);
    if (!JS_IsObject(bundle)) {
        JS_FreeValue(js->ctx, bundle);
        snprintf(err, errlen, "bundle did not set globalThis.__bundle");
        return -1;
    }
    int rc = load_schema(js, bundle, err, errlen);
    if (!rc) rc = load_slices(js, bundle, err, errlen);

    // its mode and its stack mapper
    JSValue dev = JS_GetPropertyStr(js->ctx, bundle, "dev");
    js->dev = JS_ToBool(js->ctx, dev) == 1;
    JS_FreeValue(js->ctx, dev);
    js->map_stack = JS_GetPropertyStr(js->ctx, bundle, "mapStack");
    JS_FreeValue(js->ctx, bundle);
    return rc;
}

void js_close(jsrt *js) {
    if (!js->ctx) return;
    strlist_free(&js->env_names);
    for (size_t i = 0; i < js->nslices; i++) {
        free(js->slices[i].family);
        free(js->slices[i].stream);
        strlist_free(&js->slices[i].keys);
    }
    free(js->slices);
    free(js->bundle_file);
    JS_FreeValue(js->ctx, js->source_map);
    JS_FreeValue(js->ctx, js->map_stack);
    schema_free(js->sc);
    JS_FreeValue(js->ctx, js->host);
    JS_FreeContext(js->ctx);
    JS_FreeRuntime(js->rt);
    js->ctx = NULL;
}

/* call __host[name](args...) ; returns JS_EXCEPTION with js->err set */
static JSValue call_host(jsrt *js, const char *name, int argc, JSValueConst *argv) {
    JSValue fn = JS_GetPropertyStr(js->ctx, js->host, name);
    JSValue r = JS_Call(js->ctx, fn, js->host, argc, argv);
    JS_FreeValue(js->ctx, fn);
    if (JS_IsException(r)) capture_exception(js);
    return r;
}

JSValue js_principal(jsrt *js, const char *user) {
    JSContext *ctx = js->ctx;
    JSValue p = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, p, "user", user ? JS_NewString(ctx, user) : JS_NULL);
    return p;
}

/* copy a JS array of strings into out; -1 on exception */
static int strings_of(jsrt *js, JSValueConst arr, strlist *out) {
    JSContext *ctx = js->ctx;
    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
    int64_t n = 0;
    if (JS_ToInt64(ctx, &n, lenv)) {
        JS_FreeValue(ctx, lenv);
        capture_exception(js);
        return -1;
    }
    JS_FreeValue(ctx, lenv);
    for (int64_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, arr, (uint32_t)i);
        bool nul;
        char *s = name_arg(ctx, item, &nul);
        JS_FreeValue(ctx, item);
        if (s && nul) {
            JS_ThrowTypeError(ctx, "a string beginning %s holds U+0000", s);
            free(s);
            s = NULL;
        }
        if (!s) {
            capture_exception(js);
            return -1;
        }
        strlist_push(out, s);
        free(s);
    }
    return 0;
}

/* the outputs a precommit or bootstrap answered, [{stream, event} | {stream, death: true}], each
   event's bytes under the type its stream's family folds; takes r */
static int parse_outputs(jsrt *js, JSValue r, pc_result *out) {
    JSContext *ctx = js->ctx;
    JSValue lenv = JS_GetPropertyStr(ctx, r, "length");
    int64_t n = 0;
    JS_ToInt64(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    out->items = xmalloc(sizeof(pc_item) * (n ? n : 1));
    memset(out->items, 0, sizeof(pc_item) * (n ? n : 1));
    for (int64_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, r, (uint32_t)i);
        pc_item *pi = &out->items[out->n];
        JSValue sv = JS_GetPropertyStr(ctx, item, "stream");
        bool nul = false;
        pi->stream = JS_IsString(sv) ? name_arg(ctx, sv, &nul) : NULL;
        JS_FreeValue(ctx, sv);
        JSValue dv = JS_GetPropertyStr(ctx, item, "death");
        pi->death = JS_ToBool(ctx, dv) == 1;
        JS_FreeValue(ctx, dv);
        pi->event = JS_GetPropertyStr(ctx, item, "event");
        out->n++;
        JS_FreeValue(ctx, item);
        if (!pi->stream) {
            snprintf(js->err, sizeof js->err, "precommit item without a stream");
            JS_FreeValue(ctx, r);
            return -1;
        }
        if (nul) {
            snprintf(js->err, sizeof js->err, "precommit emitted to a stream beginning %s, holding U+0000",
                     pi->stream);
            JS_FreeValue(ctx, r);
            return -1;
        }
        if (pi->death) continue;

        // the event's bytes, under the type its stream's family folds
        long type = schema_event_type(js->sc, pi->stream);
        if (type < 0) {
            snprintf(js->err, sizeof js->err, "precommit emitted to %s, a stream of no slice", pi->stream);
            JS_FreeValue(ctx, r);
            return -1;
        }
        char why[512];
        if (walk_to_mpack(&js->env, js->sc, pi->event, type, false, &pi->bytes, why, sizeof why)) {
            snprintf(js->err, sizeof js->err, "precommit's event for %s: %s", pi->stream, why);
            JS_FreeValue(ctx, r);
            return -1;
        }
    }
    JS_FreeValue(ctx, r);
    return 0;
}

int js_precommit(jsrt *js, JSValueConst data, JSValueConst principal, pc_result *out) {
    JSContext *ctx = js->ctx;
    memset(out, 0, sizeof *out);
    JSValueConst args[2] = {data, principal};
    JSValue r = call_host(js, "precommit", 2, args);
    if (JS_IsException(r)) return -1;
    if (JS_IsString(r)) {
        // a reason is text to show, which a U+0000 in it ends
        bool nul;
        out->reason = name_arg(ctx, r, &nul);
        JS_FreeValue(ctx, r);
        return 0;
    }
    return parse_outputs(js, r, out);
}

int js_bootstrap(jsrt *js, pc_result *out) {
    memset(out, 0, sizeof *out);
    JSValue r = call_host(js, "bootstrap", 0, NULL);
    if (JS_IsException(r)) return -1;
    return parse_outputs(js, r, out);
}

void pc_result_free(jsrt *js, pc_result *r) {
    free(r->reason);
    for (size_t i = 0; i < r->n; i++) {
        free(r->items[i].stream);
        JS_FreeValue(js->ctx, r->items[i].event);
        buf_free(&r->items[i].bytes);
    }
    free(r->items);
    memset(r, 0, sizeof *r);
}

int js_reduce(jsrt *js, const char *family, const char *stream, JSValueConst events) {
    JSContext *ctx = js->ctx;
    JSValue args[3] = {JS_NewString(ctx, family), JS_NewString(ctx, stream), JS_DupValue(ctx, events)};
    js->reducing = slice_of(js, stream);
    js->reducing_skip = strlen(stream) + 1;
    JSValue r = call_host(js, "reduce", 3, args);
    js->reducing = NULL;
    for (int i = 0; i < 3; i++) JS_FreeValue(ctx, args[i]);
    if (JS_IsException(r)) return -1;
    int ran = JS_ToBool(ctx, r);
    JS_FreeValue(ctx, r);
    return ran;
}

int js_maysee(jsrt *js, JSValueConst principal, strlist *out) {
    JSValue r = call_host(js, "maySee", 1, &principal);
    if (JS_IsException(r)) return -1;
    int rc = strings_of(js, r, out);
    JS_FreeValue(js->ctx, r);
    return rc;
}

int js_lookup(jsrt *js, const uint8_t *ident, size_t len, buf *out) {
    JSContext *ctx = js->ctx;
    JSValue arg = mpjs_decode(ctx, ident, len);
    if (JS_IsException(arg)) {
        capture_exception(js);
        return -1;
    }
    JSValue r = call_host(js, "lookup", 1, &arg);
    JS_FreeValue(ctx, arg);
    if (JS_IsException(r)) return -1;
    int rc = 0;
    if (!JS_IsNull(r) && !JS_IsUndefined(r)) {
        rc = mpjs_encode(ctx, r, out);
        if (rc) capture_exception(js);
    }
    JS_FreeValue(ctx, r);
    return rc;
}

int64_t js_generation(jsrt *js, JSValueConst principal) {
    JSValue r = call_host(js, "generation", 1, &principal);
    if (JS_IsException(r)) return -2;
    int64_t g = -1;
    JS_ToInt64(js->ctx, &g, r);
    JS_FreeValue(js->ctx, r);
    return g;
}
