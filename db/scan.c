/* Key patterns: the skeleton's KeyPattern compiled from the bundle's object, the skip-scan walk
   of the keys a pattern picks out over the kv cursor, and the spans the grantor's scans read.  It
   follows the skeleton's "key patterns" section step for step.  Keys and bounds are UTF-8 and
   compare bytewise, which is code-point order, the order the skeleton's comparisons keep.  A
   bound's successor is its last byte incremented, and no valid key lies between that and the
   skeleton's code-point successor. */

#include "internal.h"

/* text with its length; p is NULL when absent */
typedef struct text {
    char *p;
    size_t n;
} text;

/* A field of a compiled pattern, in key order: a literal, the local template's name with the ':'
   after it when it has parameters, matched as text; or a value field per parameter, with its
   bounds and the separator after it (0 after the last one of a key). */
typedef struct field {
    bool literal;
    text lit;
    bool whole; // the literal is a whole local key
    text lo, hi;
    bool lo_open, hi_open;
    bool single; // the field admits one value only
    char sep;
} field;

struct pattern {
    text head; // the text every key the pattern picks out starts with
    field *fields;
    size_t n;
    bool named;
};

static int cmp(const char *a, size_t an, const char *b, size_t bn) {
    size_t m = an < bn ? an : bn;
    int d = m ? memcmp(a, b, m) : 0;
    if (d) return d;
    return an < bn ? -1 : an > bn ? 1 : 0;
}

static bool starts_with(const char *s, size_t n, const char *prefix, size_t pn) {
    return n >= pn && (pn == 0 || memcmp(s, prefix, pn) == 0);
}

static text text_copy(const char *p, size_t n) {
    text t = {xmalloc(n + 1), n};
    if (n) memcpy(t.p, p, n);
    t.p[n] = 0;
    return t;
}

static text text_cat(const char *a, size_t an, const char *b, size_t bn) {
    text t = {xmalloc(an + bn + 1), an + bn};
    if (an) memcpy(t.p, a, an);
    if (bn) memcpy(t.p + an, b, bn);
    t.p[an + bn] = 0;
    return t;
}

/* the exclusive upper bound of the text sharing prefix, its last byte incremented past any 0xFF
   bytes; absent when no text lies above them all */
static text text_end(const char *p, size_t n) {
    while (n > 0 && (unsigned char)p[n - 1] == 0xFF) n--;
    if (n == 0) return (text){NULL, 0};
    text t = text_copy(p, n);
    t.p[n - 1]++;
    return t;
}

// compiling ////////////////////////////////////////////////////////////////

/* throw a plain Error, as the skeleton's compilePattern does */
static void throw_error(JSContext *ctx, const char *msg) {
    JSValue e = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, msg));
    JS_Throw(ctx, e);
}

/* a JS value's text into out; false with an exception */
static bool text_of(JSContext *ctx, JSValueConst v, text *out) {
    size_t n;
    const char *s = JS_ToCStringLen(ctx, &n, v);
    if (!s) return false;
    *out = text_copy(s, n);
    JS_FreeCString(ctx, s);
    return true;
}

/* the property name of obj as text into out, left absent when it is undefined; false with an
   exception */
static bool prop_text(JSContext *ctx, JSValueConst obj, const char *name, text *out) {
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    bool ok = JS_IsException(v) ? false : JS_IsUndefined(v) ? true : text_of(ctx, v, out);
    JS_FreeValue(ctx, v);
    return ok;
}

/* whether obj has the property name, as `name in obj` answers; -1 with an exception */
static int has_prop(JSContext *ctx, JSValueConst obj, const char *name) {
    JSAtom atom = JS_NewAtom(ctx, name);
    int has = JS_HasProperty(ctx, obj, atom);
    JS_FreeAtom(ctx, atom);
    return has;
}

static field *push_field(pattern *p) {
    p->fields = realloc(p->fields, (p->n + 1) * sizeof *p->fields);
    if (!p->fields) die("out of memory");
    field *f = &p->fields[p->n++];
    memset(f, 0, sizeof *f);
    return f;
}

/* the skeleton's valueField: a value field matching m, followed by sep; false with an
   exception */
static bool value_field(JSContext *ctx, pattern *p, JSValueConst m, char sep) {
    field *f = push_field(p);
    f->sep = sep;

    // the bounds of each kind of match; a range keeps the tighter of each pair it gives
    if (JS_IsNull(m)) return true;
    if (!JS_IsObject(m)) {
        JS_ThrowTypeError(ctx, "a parameter match is null or an object");
        return false;
    }
    int has_eq = has_prop(ctx, m, "eq");
    int has_prefix = has_eq ? 0 : has_prop(ctx, m, "prefix");
    if (has_eq < 0 || has_prefix < 0) return false;
    if (has_eq) {
        if (!prop_text(ctx, m, "eq", &f->lo)) return false;
        if (f->lo.p) f->hi = text_copy(f->lo.p, f->lo.n);
        f->single = true;
        return true;
    }
    if (has_prefix) {
        text pre = {0};
        if (!prop_text(ctx, m, "prefix", &pre)) return false;
        if (!pre.p) {
            JS_ThrowTypeError(ctx, "a prefix match names its prefix");
            return false;
        }
        if (pre.n == 0) {
            free(pre.p);
            return true;
        }
        f->lo = pre;
        f->hi = text_end(pre.p, pre.n);
        f->hi_open = true;
        return true;
    }
    text gt = {0}, lt = {0};
    if (!prop_text(ctx, m, "gte", &f->lo) || !prop_text(ctx, m, "gt", &gt) ||
        !prop_text(ctx, m, "lte", &f->hi) || !prop_text(ctx, m, "lt", &lt)) {
        free(gt.p);
        free(lt.p);
        return false;
    }
    if (gt.p && (!f->lo.p || cmp(gt.p, gt.n, f->lo.p, f->lo.n) >= 0)) {
        free(f->lo.p);
        f->lo = gt;
        f->lo_open = true;
    } else {
        free(gt.p);
    }
    if (lt.p && (!f->hi.p || cmp(lt.p, lt.n, f->hi.p, f->hi.n) <= 0)) {
        free(f->hi.p);
        f->hi = lt;
        f->hi_open = true;
    } else {
        free(lt.p);
    }
    return true;
}

/* the length of an array, or -1 with an exception when v is not one */
static int64_t array_length(JSContext *ctx, JSValueConst v, const char *what) {
    if (JS_IsArray(ctx, v) != 1) {
        JS_ThrowTypeError(ctx, "%s is an array of parameter matches", what);
        return -1;
    }
    JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
    int64_t n = -1;
    if (JS_ToInt64(ctx, &n, lenv)) n = -1;
    JS_FreeValue(ctx, lenv);
    return n;
}

/* push a value field per match in arr, each followed by sep and the last by last; false with an
   exception */
static bool value_fields(JSContext *ctx, pattern *p, JSValueConst arr, int64_t n, char sep,
                         char last) {
    for (int64_t i = 0; i < n; i++) {
        JSValue m = JS_GetPropertyUint32(ctx, arr, (uint32_t)i);
        bool ok = !JS_IsException(m) && value_field(ctx, p, m, i < n - 1 ? sep : last);
        JS_FreeValue(ctx, m);
        if (!ok) return false;
    }
    return true;
}

/* the head and slice fields of a KeyPattern's slice: one by name, a family's with a field per
   parameter, or none for every slice (an empty head); false with an exception */
static bool slice_fields(JSContext *ctx, pattern *p, JSValueConst s) {
    // one slice by name
    if (JS_IsString(s)) {
        text name;
        if (!text_of(ctx, s, &name)) return false;
        p->head = text_cat(name.p, name.n, "!", 1);
        free(name.p);
        return true;
    }
    if (!JS_IsObject(s)) {
        JS_ThrowTypeError(ctx, "a pattern's slice is a name, a family, or null");
        return false;
    }

    // a family's slices, with a field per parameter
    JSValue fam = JS_GetPropertyStr(ctx, s, "family");
    JSValue params = JS_GetPropertyStr(ctx, s, "params");
    text family = {0};
    int64_t n = -1;
    bool ok = !JS_IsException(fam) && text_of(ctx, fam, &family);
    if (ok) n = array_length(ctx, params, "a family pattern's params");
    ok = ok && n >= 0;
    if (ok) {
        p->head = text_cat(family.p, family.n, n == 0 ? "!" : ":", 1);
        ok = value_fields(ctx, p, params, n, ',', '!');
    }
    free(family.p);
    JS_FreeValue(ctx, fam);
    JS_FreeValue(ctx, params);
    return ok;
}

pattern *pattern_from_js(JSContext *ctx, JSValueConst v) {
    pattern *p = xmalloc(sizeof *p);
    memset(p, 0, sizeof *p);
    if (!JS_IsObject(v)) {
        JS_ThrowTypeError(ctx, "a scan's pattern is an object");
        pattern_free(p);
        return NULL;
    }
    JSValue s = JS_GetPropertyStr(ctx, v, "slice");
    JSValue name = JS_GetPropertyStr(ctx, v, "name");
    JSValue local = JS_GetPropertyStr(ctx, v, "local");
    bool ok = false;
    int64_t n = array_length(ctx, local, "a pattern's local");
    if (n < 0) goto out;
    if (!JS_IsNull(name) && !JS_IsString(name)) {
        JS_ThrowTypeError(ctx, "a pattern's name is a string or null");
        goto out;
    }

    // every key
    if (JS_IsNull(s)) {
        if (!JS_IsNull(name) || n > 0) {
            throw_error(ctx, "a pattern over every slice picks out every local key");
            goto out;
        }
        p->head = text_copy("", 0);
        ok = true;
        goto out;
    }

    // the slices: one by name, or a family's with a field per parameter
    if (!slice_fields(ctx, p, s)) goto out;

    // every local key of the slices, or one template's, its name a literal
    if (JS_IsNull(name)) {
        if (n > 0) {
            throw_error(ctx, "a pattern over every local key matches no parameter");
            goto out;
        }
        ok = true;
        goto out;
    }
    text tname;
    if (!text_of(ctx, name, &tname)) goto out;
    field *f = push_field(p);
    f->literal = true;
    f->lit = n > 0 ? text_cat(tname.p, tname.n, ":", 1) : text_copy(tname.p, tname.n);
    f->whole = n == 0;
    free(tname.p);
    p->named = true;
    ok = value_fields(ctx, p, local, n, ',', 0);

out:
    JS_FreeValue(ctx, s);
    JS_FreeValue(ctx, name);
    JS_FreeValue(ctx, local);
    if (ok) return p;
    pattern_free(p);
    return NULL;
}

void pattern_free(pattern *p) {
    if (!p) return;
    for (size_t i = 0; i < p->n; i++) {
        free(p->fields[i].lit.p);
        free(p->fields[i].lo.p);
        free(p->fields[i].hi.p);
    }
    free(p->fields);
    free(p->head.p);
    free(p);
}

bool pattern_named(const pattern *p) { return p->named; }

// placing a key ////////////////////////////////////////////////////////////

/* where a key stands against a pattern, for a walk one way: a match, a key to step past, the end
   of the walk, or the target of a seek to the next key that may match */
typedef enum { PLACE_MATCH, PLACE_STEP, PLACE_DONE, PLACE_SEEK } place_kind;

typedef struct placement {
    buf target; // a seek's target; its bytes are rewritten by every placement
    bool strict;
    size_t *ends; // the end of each value field's text so far, by field
    size_t cap;   // the fields ends has room for
} placement;

static void placement_free(placement *pl) {
    buf_free(&pl->target);
    free(pl->ends);
}

/* a seek to the key's first at bytes, then tail */
static place_kind seek_to(placement *pl, const char *key, size_t at, const char *tail, size_t n,
                          bool strict) {
    pl->target.len = 0;
    buf_append(&pl->target, key, at);
    if (n) buf_append(&pl->target, tail, n);
    pl->strict = strict;
    return PLACE_SEEK;
}

/* past every key holding the value of the nearest varying field before field i */
static place_kind skip_back(const pattern *c, size_t i, const size_t *ends, const char *key,
                            bool reverse, placement *pl) {
    for (size_t j = i; j-- > 0;) {
        const field *f = &c->fields[j];
        if (f->literal || f->single) continue;
        if (reverse) return seek_to(pl, key, ends[j] + 1, NULL, 0, true);
        char above = (char)(f->sep + 1);
        return seek_to(pl, key, ends[j], &above, 1, false);
    }
    return PLACE_DONE;
}

/* Place a key the way a skip scan does: the skeleton's placeKey.  The first field outside its
   match decides: a field short of its match seeks to where the match begins, and a field past it
   seeks past every key holding the value of the nearest field before it that admits more than
   one, or ends the walk when no such field does.  Seek targets are in walk order. */
static place_kind place_key(const pattern *c, const char *key, size_t n, bool reverse,
                            placement *pl) {
    if (!starts_with(key, n, c->head.p, c->head.n)) return PLACE_DONE;

    // room for each field's end
    if (pl->cap < c->n) {
        pl->ends = realloc(pl->ends, c->n * sizeof *pl->ends);
        if (!pl->ends) die("out of memory");
        pl->cap = c->n;
    }
    size_t *ends = pl->ends;

    size_t pos = c->head.n;
    for (size_t i = 0; i < c->n; i++) {
        const field *f = &c->fields[i];

        // a literal: the template's keys start with it, or are it when it is a whole local key
        if (f->literal) {
            bool has = starts_with(key + pos, n - pos, f->lit.p, f->lit.n) &&
                       (!f->whole || n == pos + f->lit.n);
            if (has) {
                pos += f->lit.n;
                continue;
            }
            if (cmp(key + pos, n - pos, f->lit.p, f->lit.n) < 0) {
                if (reverse) return skip_back(c, i, ends, key, reverse, pl);
                return seek_to(pl, key, pos, f->lit.p, f->lit.n, false);
            }
            if (!reverse) return skip_back(c, i, ends, key, reverse, pl);
            if (f->whole) return seek_to(pl, key, pos, f->lit.p, f->lit.n, false);
            text end = text_end(f->lit.p, f->lit.n);
            place_kind k = seek_to(pl, key, pos, end.p, end.n, true);
            free(end.p);
            return k;
        }

        // a value field: its text runs to its separator, or to the end for the last field
        size_t end = n;
        bool short_ = false;
        if (f->sep) {
            const char *at = memchr(key + pos, f->sep, n - pos);
            if (at) {
                end = (size_t)(at - key);
            } else {
                short_ = true;
            }
        }
        const char *v = key + pos;
        size_t vn = end - pos;

        // is the value short of its match?
        if (f->lo.p) {
            int d = cmp(v, vn, f->lo.p, f->lo.n);
            if (d < 0 || (d == 0 && f->lo_open)) {
                if (reverse) return skip_back(c, i, ends, key, reverse, pl);
                if (!f->lo_open) return seek_to(pl, key, pos, f->lo.p, f->lo.n, false);
                if (!f->sep) return seek_to(pl, key, pos, f->lo.p, f->lo.n, true);
                seek_to(pl, key, pos, f->lo.p, f->lo.n, false);
                char above = (char)(f->sep + 1);
                buf_append(&pl->target, &above, 1);
                return PLACE_SEEK;
            }
        }

        // is it past its match?
        if (f->hi.p) {
            int d = cmp(v, vn, f->hi.p, f->hi.n);
            if (d > 0 || (d == 0 && f->hi_open)) {
                if (!reverse) return skip_back(c, i, ends, key, reverse, pl);
                if (f->hi_open) return seek_to(pl, key, pos, f->hi.p, f->hi.n, true);
                if (!f->sep) return seek_to(pl, key, pos, f->hi.p, f->hi.n, false);
                seek_to(pl, key, pos, f->hi.p, f->hi.n, true);
                char above = (char)(f->sep + 1);
                buf_append(&pl->target, &above, 1);
                return PLACE_SEEK;
            }
        }

        // inside its match, but a key that ends here holds none of the fields after it
        if (short_) return PLACE_STEP;
        ends[i] = end;
        pos = end + (f->sep ? 1 : 0);
    }
    return PLACE_MATCH;
}

// walking //////////////////////////////////////////////////////////////////

/* whether the walk has reached a seek's target with the cursor at key */
static bool past(const placement *pl, const char *key, size_t n, bool reverse) {
    const char *t = (const char *)pl->target.p;
    int d = reverse ? cmp(t, pl->target.len, key, n) : cmp(key, n, t, pl->target.len);
    return d > 0 || (d == 0 && !pl->strict);
}

/* Walk the keys a pattern picks out: the skeleton's walkPattern.  Before a seek the walk steps
   up to budget keys toward the target, since a seek costs more than a few steps over the short
   gaps between matches. */
int pattern_walk(store *s, const pattern *c, bool reverse, const char *after, size_t after_n,
                 size_t budget, pattern_visit_fn visit, void *arg) {
    placement pl = {0};
    int rc = 0;

    // start just past after, or at the pattern's first key in walk order
    int at;
    if (after) {
        at = store_cursor_seek(s, reverse, after, after_n, true);
    } else if (!reverse) {
        at = store_cursor_seek(s, false, c->head.p, c->head.n, false);
    } else {
        text end = text_end(c->head.p, c->head.n);
        at = store_cursor_seek(s, true, end.p, end.n, end.p != NULL);
        free(end.p);
    }

    while (at > 0) {
        size_t n;
        const char *key = store_cursor_key(s, &n);
        place_kind k = place_key(c, key, n, reverse, &pl);
        if (k == PLACE_DONE) break;
        if (k == PLACE_MATCH) {
            rc = visit(arg, key, n);
            if (rc <= 0) break;
        }
        if (k != PLACE_SEEK) {
            at = store_cursor_step(s);
            continue;
        }

        // a target behind the key comes from a bound holding characters its parameter cannot,
        // which orders differently against the separators; stepping is always safe
        if (past(&pl, key, n, reverse)) {
            at = store_cursor_step(s);
            continue;
        }

        // step toward the target, then seek if it is still ahead
        size_t i = 0;
        for (; i < budget; i++) {
            at = store_cursor_step(s);
            if (at <= 0) break;
            key = store_cursor_key(s, &n);
            if (past(&pl, key, n, reverse)) break;
        }
        if (i == budget) {
            at = store_cursor_seek(s, reverse, (const char *)pl.target.p, pl.target.len,
                                   pl.strict);
        }
    }
    store_cursor_end(s);
    placement_free(&pl);
    return at < 0 || rc < 0 ? -1 : 0;
}

// spans ////////////////////////////////////////////////////////////////////

static bool text_eq(text a, text b) {
    if (!a.p || !b.p) return !a.p && !b.p;
    return a.n == b.n && memcmp(a.p, b.p, a.n) == 0;
}

// whether two compiled patterns pick out the same keys in the same way
static bool pattern_equal(const pattern *a, const pattern *b) {
    if (!text_eq(a->head, b->head) || a->n != b->n) return false;
    for (size_t i = 0; i < a->n; i++) {
        const field *x = &a->fields[i], *y = &b->fields[i];
        if (x->literal != y->literal) return false;
        if (x->literal && (!text_eq(x->lit, y->lit) || x->whole != y->whole)) return false;
        if (x->literal) continue;
        if (!text_eq(x->lo, y->lo) || !text_eq(x->hi, y->hi)) return false;
        if (x->lo_open != y->lo_open || x->hi_open != y->hi_open || x->sep != y->sep) return false;
    }
    return true;
}

void span_list_push(span_list *l, pattern *pattern, bool reverse, const char *from, size_t from_n,
                    const char *to, size_t to_n) {
    // the next batch of the last span's walk, resuming where it ends, extends it
    scan_span *last = l->n ? &l->v[l->n - 1] : NULL;
    if (last && from && last->to && last->reverse == reverse && last->to_n == from_n &&
        memcmp(last->to, from, from_n) == 0 && pattern_equal(last->pattern, pattern)) {
        free(last->to);
        last->to = to ? text_copy(to, to_n).p : NULL;
        last->to_n = to_n;
        pattern_free(pattern);
        return;
    }

    // any other batch starts a span of its own
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 4;
        l->v = realloc(l->v, l->cap * sizeof *l->v);
        if (!l->v) die("out of memory");
    }
    scan_span *sp = &l->v[l->n++];
    sp->pattern = pattern;
    sp->reverse = reverse;
    sp->from = from ? text_copy(from, from_n).p : NULL;
    sp->from_n = from_n;
    sp->to = to ? text_copy(to, to_n).p : NULL;
    sp->to_n = to_n;
}

void span_list_clear(span_list *l) {
    for (size_t i = 0; i < l->n; i++) {
        pattern_free(l->v[i].pattern);
        free(l->v[i].from);
        free(l->v[i].to);
    }
    l->n = 0;
}

void span_list_free(span_list *l) {
    span_list_clear(l);
    free(l->v);
    memset(l, 0, sizeof *l);
}

bool pattern_matches(const pattern *p, const char *key, size_t n) {
    placement pl = {0};
    bool match = place_key(p, key, n, false, &pl) == PLACE_MATCH;
    placement_free(&pl);
    return match;
}

bool span_covers(const scan_span *s, const char *key, size_t n) {
    if (s->from) {
        int d = cmp(key, n, s->from, s->from_n);
        if (s->reverse ? d >= 0 : d <= 0) return false;
    }
    if (s->to) {
        int d = cmp(key, n, s->to, s->to_n);
        if (s->reverse ? d < 0 : d > 0) return false;
    }
    return pattern_matches(s->pattern, key, n);
}

/* Every key under the prefix lies in one stretch of key order, and every key the span covers
   starts with the pattern's head and lies in the stretch its walk covered.  So a key under the
   prefix can lie inside the span only when the prefix and the head agree, one starting with the
   other, and the two stretches overlap.  Within that, the span is taken to hold the key. */
bool span_may_hold(const scan_span *s, const char *prefix, size_t n) {
    const text *h = &s->pattern->head;
    if (!starts_with(prefix, n, h->p, h->n) && !starts_with(h->p, h->n, prefix, n)) return false;

    // the stretch's bounds in key order: forward from past from to to, reversed from to to
    // short of from
    const char *lo = s->reverse ? s->to : s->from;
    const char *hi = s->reverse ? s->from : s->to;
    size_t lo_n = s->reverse ? s->to_n : s->from_n;
    size_t hi_n = s->reverse ? s->from_n : s->to_n;
    bool hi_open = s->reverse;

    // the least key under the prefix is the prefix itself, which must lie below the upper bound
    if (hi) {
        int d = cmp(prefix, n, hi, hi_n);
        if (d > 0 || (d == 0 && hi_open)) return false;
    }

    // some key under the prefix lies above the lower bound unless the bound is above them all
    if (lo && cmp(lo, lo_n, prefix, n) > 0 && !starts_with(lo, lo_n, prefix, n)) return false;
    return true;
}
