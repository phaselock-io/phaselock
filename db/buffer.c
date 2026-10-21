/* A mutation's write buffer.  See internal.h.  Entries live in one array, found by key through an
   open-addressing table of their indices, so a write is a lookup and an append whatever the
   buffer's size.  A scan or a commit sorts the array in place and rebuilds the table; the next
   write after that appends out of order again. */

#include "internal.h"

static uint64_t key_hash(const char *key, size_t n) {
    return pl_fnv1a(key, n, 14695981039346656037ull);
}

static int key_cmp(const char *a, size_t an, const char *b, size_t bn) {
    size_t m = an < bn ? an : bn;
    int d = m ? memcmp(a, b, m) : 0;
    if (d) return d;
    return an < bn ? -1 : an > bn ? 1 : 0;
}

// the table's slot for key: the one holding its entry, or the empty one where it would go
static size_t slot_of(const wbuf *b, const char *key, size_t n) {
    size_t mask = b->nslots - 1;
    for (size_t i = key_hash(key, n) & mask;; i = (i + 1) & mask) {
        size_t at = b->slots[i];
        if (at == 0) return i;
        const wentry *e = &b->v[at - 1];
        if (e->n == n && memcmp(e->key, key, n) == 0) return i;
    }
}

// rebuild the table over the entries, at a size that keeps it at most half full
static void rehash(wbuf *b) {
    size_t want = 16;
    while (want < 2 * (b->n + 1)) want *= 2;
    if (want != b->nslots) {
        free(b->slots);
        b->slots = xmalloc(want * sizeof *b->slots);
        b->nslots = want;
    }
    memset(b->slots, 0, b->nslots * sizeof *b->slots);
    for (size_t i = 0; i < b->n; i++) b->slots[slot_of(b, b->v[i].key, b->v[i].n)] = i + 1;
}

void wbuf_put(wbuf *b, const char *key, size_t n, const uint8_t *val, size_t len) {
    // the key's entry, which a key already written keeps, or a new one
    if (b->nslots < 2 * (b->n + 1)) rehash(b);
    size_t slot = slot_of(b, key, n);
    wentry *e;
    if (b->slots[slot]) {
        e = &b->v[b->slots[slot] - 1];
        free(e->val);
    } else {
        if (b->n == b->cap) {
            b->cap = b->cap ? b->cap * 2 : 16;
            b->v = realloc(b->v, b->cap * sizeof *b->v);
            if (!b->v) die("out of memory");
        }
        e = &b->v[b->n++];
        e->key = xmalloc(n + 1);
        memcpy(e->key, key, n);
        e->key[n] = 0;
        e->n = n;
        b->slots[slot] = b->n;

        // the entries stay in key order while each new key comes after the last
        const wentry *last = b->n > 1 ? &b->v[b->n - 2] : NULL;
        b->sorted = !last || (b->sorted && key_cmp(last->key, last->n, key, n) < 0);
    }

    // its value, or the deletion
    e->val = NULL;
    e->len = 0;
    if (val) {
        e->val = xmalloc(len ? len : 1);
        memcpy(e->val, val, len);
        e->len = len;
    }
}

const wentry *wbuf_find(const wbuf *b, const char *key, size_t n) {
    if (b->n == 0) return NULL;
    size_t at = b->slots[slot_of(b, key, n)];
    return at ? &b->v[at - 1] : NULL;
}

void wbuf_delete_slice(wbuf *b, const char *slice, bool erase) {
    // the entries under the slice go, since the deletion clears it
    size_t sn = strlen(slice);
    size_t kept = 0;
    for (size_t i = 0; i < b->n; i++) {
        wentry *e = &b->v[i];
        if (e->n > sn && e->key[sn] == '!' && memcmp(e->key, slice, sn) == 0) {
            free(e->key);
            free(e->val);
            continue;
        }
        b->v[kept++] = *e;
    }
    if (kept != b->n) {
        b->n = kept;
        rehash(b);
    }

    // the deletion, which one made before it joins, erasing if either does
    for (size_t i = 0; i < b->ndels; i++) {
        if (strcmp(b->dels[i].slice, slice) == 0) {
            b->dels[i].erase = b->dels[i].erase || erase;
            return;
        }
    }
    if (b->ndels == b->capdels) {
        b->capdels = b->capdels ? b->capdels * 2 : 4;
        b->dels = realloc(b->dels, b->capdels * sizeof *b->dels);
        if (!b->dels) die("out of memory");
    }
    b->dels[b->ndels++] = (wdel){xstrdup(slice), erase};
}

const wdel *wbuf_deleted(const wbuf *b, const char *key, size_t n) {
    if (b->ndels == 0) return NULL;
    const char *bang = memchr(key, '!', n);
    if (!bang) return NULL;
    size_t sn = (size_t)(bang - key);
    for (size_t i = 0; i < b->ndels; i++) {
        const char *s = b->dels[i].slice;
        if (strlen(s) == sn && memcmp(s, key, sn) == 0) return &b->dels[i];
    }
    return NULL;
}

static int entry_cmp(const void *x, const void *y) {
    const wentry *a = x, *b = y;
    return key_cmp(a->key, a->n, b->key, b->n);
}

static int del_cmp(const void *x, const void *y) {
    return strcmp(((const wdel *)x)->slice, ((const wdel *)y)->slice);
}

void wbuf_sort(wbuf *b) {
    if (b->ndels > 1) qsort(b->dels, b->ndels, sizeof *b->dels, del_cmp);
    if (b->sorted) return;
    qsort(b->v, b->n, sizeof *b->v, entry_cmp);
    rehash(b);
    b->sorted = true;
}

size_t wbuf_seek(const wbuf *b, const char *key, size_t n, bool strict) {
    size_t lo = 0, hi = b->n;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int d = key_cmp(b->v[mid].key, b->v[mid].n, key, n);
        if (d < 0 || (d == 0 && strict)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

bool wbuf_empty(const wbuf *b) { return b->n == 0 && b->ndels == 0; }

void wbuf_clear(wbuf *b) {
    for (size_t i = 0; i < b->n; i++) {
        free(b->v[i].key);
        free(b->v[i].val);
    }
    b->n = 0;
    if (b->nslots) memset(b->slots, 0, b->nslots * sizeof *b->slots);
    b->sorted = true;
    for (size_t i = 0; i < b->ndels; i++) free(b->dels[i].slice);
    b->ndels = 0;
}

void wbuf_free(wbuf *b) {
    wbuf_clear(b);
    free(b->v);
    free(b->slots);
    free(b->dels);
    memset(b, 0, sizeof *b);
}
