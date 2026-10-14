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
