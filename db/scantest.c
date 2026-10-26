/* Test only: the bundle's JS host over a store of its own, with no txn thread, for the scan
   conformance test (scan_test.go).  The test fills the store with keys no decider could write
   and calls the host's __pl_scan, the native behind every transaction's scan, so it drives the
   pattern walk the bundle's scans take.  Nothing on the server's paths calls it. */

#include "internal.h"

struct pldb_scantest {
    store *st;
    jsrt js;
};

/* cgo runs each call on whichever thread's stack it has at hand, so QuickJS measures its stack
   from the call's own */
static void enter(pldb_scantest *t) { JS_UpdateStackTop(t->js.rt); }

pldb_scantest *pldb_scantest_open(const char *host, size_t hostlen, const char *bundle,
                                  const char *path, int budget, char *err, size_t errlen) {
    pldb_scantest *t = xmalloc(sizeof *t);
    memset(t, 0, sizeof *t);
    if (store_open(path, true, 0, &t->st, err, errlen)) {
        free(t);
        return NULL;
    }
    if (js_open(&t->js, host, hostlen, bundle, t->st, err, errlen)) {
        pldb_scantest_close(t);
        return NULL;
    }
    if (budget >= 0) t->js.scan_budget = (size_t)budget;
    return t;
}

void pldb_scantest_close(pldb_scantest *t) {
    if (t->js.rt) enter(t);
    js_close(&t->js);
    store_close(t->st);
    free(t);
}

int pldb_scantest_put(pldb_scantest *t, const char *key, const char *type, const char *value,
                      char *err, size_t errlen) {
    enter(t);

    // the value, converted under its type as a decider's write would be
    long node = schema_lookup(t->js.sc, type, strlen(type));
    if (node < 0) {
        snprintf(err, errlen, "no registry entry for type %s", type);
        return -1;
    }
    JSValue v = JS_NewString(t->js.ctx, value);
    buf b = {0};
    int rc = walk_to_mpack(&t->js.env, t->js.sc, v, node, false, &b, err, errlen);
    JS_FreeValue(t->js.ctx, v);

    // stored under the key as it is, which the write gate never sees
    if (!rc && store_set(t->st, key, b.p, b.len)) {
        snprintf(err, errlen, "%s", store_err(t->st));
        rc = -1;
    }
    buf_free(&b);
    return rc;
}

char *pldb_scantest_scan(pldb_scantest *t, const char *req, int *failed) {
    enter(t);
    JSContext *ctx = t->js.ctx;

    // the request, as JSON, through __pl_scan
    JSValue r = JS_ParseJSON(ctx, req, strlen(req), "<scan request>");
    if (!JS_IsException(r)) {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue fn = JS_GetPropertyStr(ctx, global, "__pl_scan");
        JSValue arg = r;
        r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
        JS_FreeValue(ctx, arg);
        JS_FreeValue(ctx, fn);
        JS_FreeValue(ctx, global);
    }

    // its batch as JSON, or the message of what it threw
    JSValue out = JS_IsException(r) ? r : JS_JSONStringify(ctx, r, JS_UNDEFINED, JS_UNDEFINED);
    if (!JS_IsException(r)) JS_FreeValue(ctx, r);
    *failed = JS_IsException(out);
    if (*failed) out = JS_GetException(ctx);
    const char *s = JS_IsException(out) ? NULL : JS_ToCString(ctx, out);
    char *text = xstrdup(s ? s : "the scan's answer would not convert to text");
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, out);
    if (!s) *failed = 1;
    return text;
}
