#include <stdarg.h>

#include "internal.h"

static uint32_t table[256];
static int have_table;

static void init_table(void) {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c & 1) ? 0x82F63B78u ^ (c >> 1) : c >> 1;
        table[i] = c;
    }
    have_table = 1;
}

uint32_t pl_crc32c(const void *data, size_t len) {
    if (!have_table) init_table();
    const uint8_t *p = data;
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) c = table[(c ^ p[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

uint64_t pl_fnv1a(const void *data, size_t len, uint64_t h) {
    const uint8_t *p = data;
    for (size_t i = 0; i < len; i++) {
        h ^= p[i];
        h *= 1099511628211ull;
    }
    return h;
}

void die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "pldb: fatal: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    abort();
}

void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

char *xstrdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *p = xmalloc(n);
    memcpy(p, s, n);
    return p;
}

void buf_append(buf *b, const void *data, size_t len) {
    if (b->len + len > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 256;
        while (cap < b->len + len) cap *= 2;
        b->p = realloc(b->p, cap);
        if (!b->p) die("out of memory");
        b->cap = cap;
    }
    memcpy(b->p + b->len, data, len);
    b->len += len;
}

void buf_u32(buf *b, uint32_t v) {
    uint8_t x[4] = {v >> 24, v >> 16, v >> 8, v};
    buf_append(b, x, 4);
}

void buf_u64(buf *b, uint64_t v) {
    buf_u32(b, (uint32_t)(v >> 32));
    buf_u32(b, (uint32_t)v);
}

void buf_free(buf *b) {
    free(b->p);
    b->p = NULL;
    b->len = b->cap = 0;
}

void strlist_push(strlist *l, const char *s) {
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 8;
        l->v = realloc(l->v, l->cap * sizeof(char *));
        if (!l->v) die("out of memory");
    }
    l->v[l->n++] = xstrdup(s);
}

bool strlist_has(const strlist *l, const char *s) {
    for (size_t i = 0; i < l->n; i++)
        if (strcmp(l->v[i], s) == 0) return true;
    return false;
}

void strlist_clear(strlist *l) {
    for (size_t i = 0; i < l->n; i++) free(l->v[i]);
    l->n = 0;
}

void strlist_free(strlist *l) {
    strlist_clear(l);
    free(l->v);
    l->v = NULL;
    l->cap = 0;
}

static int cmpstr(const void *a, const void *b) {
    return strcmp(*(char *const *)a, *(char *const *)b);
}

void strlist_sort(strlist *l) {
    if (l->n > 1) qsort(l->v, l->n, sizeof(char *), cmpstr);
}

// the hash's slot for s: the one naming its last add, or the empty one where it would go
static size_t strtab_slot(const strtab *t, const char *s) {
    size_t mask = t->nslots - 1;
    uint64_t h = pl_fnv1a(s, strlen(s), 14695981039346656037ull);
    for (size_t i = h & mask;; i = (i + 1) & mask) {
        size_t at = t->slots[i];
        if (at == 0 || strcmp(t->v[at - 1], s) == 0) return i;
    }
}

// rebuild the hash over the entries, at a size that keeps it at most half full
static void strtab_rehash(strtab *t) {
    size_t want = 16;
    while (want < 2 * (t->n + 1)) want *= 2;
    if (want != t->nslots) {
        free(t->slots);
        t->slots = xmalloc(want * sizeof *t->slots);
        t->nslots = want;
    }
    memset(t->slots, 0, t->nslots * sizeof *t->slots);
    for (size_t i = 0; i < t->n; i++) t->slots[strtab_slot(t, t->v[i])] = i + 1;
}

size_t strtab_add(strtab *t, const char *s) {
    if (t->nslots < 2 * (t->n + 1)) strtab_rehash(t);
    if (t->n == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 16;
        t->v = realloc(t->v, t->cap * sizeof *t->v);
        if (!t->v) die("out of memory");
    }
    t->v[t->n] = xstrdup(s);
    t->slots[strtab_slot(t, s)] = ++t->n;
    return t->n - 1;
}

void strtab_put(strtab *t, const char *s) {
    if (strtab_find(t, s) < 0) strtab_add(t, s);
}

long strtab_find(const strtab *t, const char *s) {
    if (t->n == 0) return -1;
    size_t at = t->slots[strtab_slot(t, s)];
    return at ? (long)at - 1 : -1;
}

bool strtab_last(const strtab *t, size_t i) { return strtab_find(t, t->v[i]) == (long)i; }

void strtab_clear(strtab *t) {
    for (size_t i = 0; i < t->n; i++) free(t->v[i]);
    t->n = 0;
    if (t->nslots) memset(t->slots, 0, t->nslots * sizeof *t->slots);
}

void strtab_free(strtab *t) {
    strtab_clear(t);
    free(t->v);
    free(t->slots);
    memset(t, 0, sizeof *t);
}
