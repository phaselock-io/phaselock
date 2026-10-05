/* Stream names and keys against their slice's templates.  A template is a name, then one
   ".{param}" segment per parameter.  A parameter the template ends with is terminal and holds
   the rest of the string; every other parameter is a segment, a non-empty run of
   A-Z a-z 0-9 _ -.  A stream name's terminal parameter is non-empty and may also hold '.' and
   '~'; a local key's may hold anything a key may, the empty string included. */

#include "internal.h"

static bool segment_char(char c) {
    switch (c) {
    case 'a' ... 'z':
    case 'A' ... 'Z':
    case '0' ... '9':
    case '_':
    case '-':
        return true;
    default:
        return false;
    }
}

/* what a string fills a template as */
typedef enum { AS_STREAM, AS_KEY, AS_PREFIX } fill_as;

/* Whether s fills tpl: the template's literal text exactly, and a value per parameter.  As a
   prefix, s fills tpl when it ends at the dot before a parameter, every parameter before it
   filled, so "chat" and "chat.acme" are prefixes of "chat.{org}.{channel}" and
   "chat.acme.general" is not. */
static bool fills(const char *tpl, const char *s, fill_as as) {
    while (*tpl) {
        // a prefix may end at the dot before any parameter
        if (as == AS_PREFIX && !*s && tpl[0] == '.' && tpl[1] == '{') return true;

        // literal text matches itself
        if (*tpl != '{') {
            if (*s != *tpl) return false;
            s++, tpl++;
            continue;
        }

        // a parameter: skip its name
        tpl = strchr(tpl, '}');
        if (!tpl) return false;
        tpl++;

        // if the parameter is terminal, it is the rest of s, which a prefix never reaches
        if (!*tpl) {
            if (as == AS_KEY) return true;
            if (as == AS_PREFIX || !*s) return false;
            for (; *s; s++)
                if (!segment_char(*s) && *s != '.' && *s != '~') return false;
            return true;
        }

        // otherwise it is a segment
        const char *start = s;
        while (segment_char(*s)) s++;
        if (s == start) return false;
    }
    return as != AS_PREFIX && !*s;
}

/* the length of a name's first segment, its family or its key name */
static size_t first_segment(const char *s) {
    const char *dot = strchr(s, '.');
    return dot ? (size_t)(dot - s) : strlen(s);
}

const slice_names *slice_of(const jsrt *js, const char *stream) {
    size_t n = first_segment(stream);
    for (size_t i = 0; i < js->nslices; i++) {
        const char *f = js->slices[i].family;
        if (strlen(f) == n && memcmp(f, stream, n) == 0) return &js->slices[i];
    }
    return NULL;
}

bool stream_fills(const jsrt *js, const char *name) {
    const slice_names *sl = slice_of(js, name);
    return sl && fills(sl->stream, name, AS_STREAM);
}

bool ref_prefix_fills(const jsrt *js, const char *prefix) {
    const slice_names *sl = slice_of(js, prefix);
    return sl && fills(sl->stream, prefix, AS_PREFIX);
}

bool key_fills(const slice_names *sl, const char *key) {
    size_t n = first_segment(key);
    for (size_t i = 0; i < sl->keys.n; i++) {
        const char *tpl = sl->keys.v[i];
        if (first_segment(tpl) == n && memcmp(tpl, key, n) == 0) return fills(tpl, key, AS_KEY);
    }
    return false;
}
