/* Slice names and the characters of a key.  A slice name is a family, then, if it has parameters,
   ':' and their values separated by ',': "chat:acme,general", "post:p1", "meta".  The family and
   every value but the last is a segment, a non-empty run of A-Z a-z 0-9 _ -, and the last value
   is non-empty and may also hold . and ~.  No key holds a control character (U+0000-001F,
   U+007F-009F) or a lone surrogate. */

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

/* the end of the segment s begins with, or NULL when s does not begin with one */
static const char *segment_end(const char *s) {
    const char *p = s;
    while (segment_char(*p)) p++;
    return p == s ? NULL : p;
}

bool slice_name_ok(const char *name) {
    // the family, then its parameters or the end
    const char *p = segment_end(name);
    if (!p || (*p && *p != ':')) return false;

    // each parameter: a segment followed by ',', or the last, which may also hold '.' and '~'
    while (*p) {
        const char *start = ++p;
        while (segment_char(*p)) p++;
        if (*p == ',' && p > start) continue;
        while (segment_char(*p) || *p == '.' || *p == '~') p++;
        if (*p || p == start) return false;
    }
    return true;
}

bool selector_prefix_ok(const char *prefix) {
    // the family and its ':'
    const char *p = segment_end(prefix);
    if (!p || *p != ':') return false;

    // whole leading parameters, each a segment followed by ','
    while (*++p) {
        p = segment_end(p);
        if (!p || *p != ',') return false;
    }
    return true;
}

/* QuickJS writes a key as UTF-8, except that a lone surrogate becomes ED A0-BF and a continuation
   byte, so a control character is a byte below 0x20, 0x7F, or C2 80-9F */
bool key_chars_ok(const char *key) {
    for (const unsigned char *p = (const unsigned char *)key; *p; p++) {
        if (*p < 0x20 || *p == 0x7f) return false;
        if (p[0] == 0xc2 && p[1] >= 0x80 && p[1] <= 0x9f) return false;
        if (p[0] == 0xed && p[1] >= 0xa0) return false;
    }
    return true;
}
