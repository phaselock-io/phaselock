//! Slice names, selectors, and the characters of a key.  A slice name is a family, then, if it has
//! parameters, ':' and their values separated by ',': "chat:acme,general", "post:p1", "meta".
//! The family and every value but the last is a segment, a non-empty run of A-Z a-z 0-9 _ -, and
//! the last value is non-empty and may also hold . and ~.  No key holds a control character
//! (U+0000-001F, U+007F-009F) or a lone surrogate.  A store key holds at most KEY_MAX bytes, the
//! most an LMDB key holds by default, and a slice name at most SLICE_MAX, one less, the shortest
//! key under it being "<slice>!".

/// the most bytes a store key holds
pub const KEY_MAX: usize = 511;
/// the most bytes a slice name holds
pub const SLICE_MAX: usize = KEY_MAX - 1;

fn segment_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
}

fn segment(s: &[u8]) -> bool {
    !s.is_empty() && s.iter().all(|&c| segment_char(c))
}

/// whether a string is a slice name: a family, then optionally ':' and its parameters' values
/// separated by ',', SLICE_MAX bytes at most
pub fn slice_name_ok(name: &[u8]) -> bool {
    if name.len() > SLICE_MAX {
        return false;
    }
    let (family, rest) = match name.iter().position(|&c| c == b':') {
        Some(i) => (&name[..i], Some(&name[i + 1..])),
        None => (name, None),
    };
    if !segment(family) {
        return false;
    }
    let Some(rest) = rest else { return true };

    // every value but the last a segment, and the last one non-empty, which may also hold . and ~
    let (leading, last) = match rest.iter().rposition(|&c| c == b',') {
        Some(i) => (Some(&rest[..i]), &rest[i + 1..]),
        None => (None, rest),
    };
    if leading.is_some_and(|l| !l.split(|&c| c == b',').all(segment)) {
        return false;
    }
    !last.is_empty() && last.iter().all(|&c| segment_char(c) || c == b'.' || c == b'~')
}

/// whether a prefix selector's text before its star ("chat:", "chat:acme,") is a family and ':',
/// then whole leading values, each followed by ',', and shorter than SLICE_MAX bytes, since a
/// slice name it covers is longer
pub fn selector_prefix_ok(prefix: &[u8]) -> bool {
    if prefix.len() >= SLICE_MAX {
        return false;
    }
    let Some(i) = prefix.iter().position(|&c| c == b':') else { return false };
    if !segment(&prefix[..i]) {
        return false;
    }
    let rest = &prefix[i + 1..];
    if rest.is_empty() {
        return true;
    }
    let Some(body) = rest.strip_suffix(b",") else { return false };
    body.split(|&c| c == b',').all(segment)
}

/// Whether a key's bytes hold no control character and no lone surrogate.  QuickJS writes a key
/// as UTF-8, except that a lone surrogate becomes ED A0-BF and a continuation byte, so a control
/// character is a byte below 0x20, 0x7F, or C2 80-9F.
pub fn key_chars_ok(key: &[u8]) -> bool {
    for (i, &c) in key.iter().enumerate() {
        if c < 0x20 || c == 0x7f {
            return false;
        }
        let next = key.get(i + 1).copied().unwrap_or(0);
        if c == 0xc2 && (0x80..=0x9f).contains(&next) {
            return false;
        }
        if c == 0xed && next >= 0xa0 {
            return false;
        }
    }
    true
}

/// A selector in wire form is an exact one, a slice name, or a prefix one: "chat:*" or
/// "chat:acme,*" for every slice whose name begins with its text before the star, or "*" for
/// every slice.
pub fn is_prefix_selector(selector: &str) -> bool {
    let b = selector.as_bytes();
    if b.len() == 1 {
        return b[0] == b'*';
    }
    b.len() > 2 && b[b.len() - 1] == b'*' && (b[b.len() - 2] == b':' || b[b.len() - 2] == b',')
}

/// Checks the wire form of a selector: a slice name, a prefix selector, or "*".  A prefix
/// selector is a family and ':', or a family, ':', and whole leading values each followed by
/// ',', then '*'.  The core checks a grantor's selectors, and the slice names a write or an
/// expectation gives, by the same rules.
pub fn valid_selector(selector: &str) -> bool {
    if selector == "*" {
        return true;
    }
    match selector.strip_suffix('*') {
        Some(prefix) => selector_prefix_ok(prefix.as_bytes()),
        None => slice_name_ok(selector.as_bytes()),
    }
}

/// Whether a selector covers a slice name or a narrower selector: a prefix selector ("*",
/// "chat:*", "chat:acme,*") covers the names that begin with its text before the star, and an
/// exact one, a slice's name, covers itself.
pub fn matches(name: &str, selector: &str) -> bool {
    match selector.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => name == selector,
    }
}

/// whether the view's selectors grant the whole selector
pub fn covers(selectors: &[String], selector: &str) -> bool {
    selectors.iter().any(|s| matches(selector, s))
}

/// The grantor returns selectors with a terminator on every entry: a prefix selector ("chat:*",
/// "chat:acme,*", "*") or "name!" for an exact one, so a bare name is never a grant.  Answers the
/// selector in wire form, or None for a malformed entry: a bare name, an exact one whose name is
/// not a slice name, or a prefix selector that cuts into a parameter.
pub fn normalize_bundle_selector(selector: &str) -> Option<String> {
    if selector == "*" {
        return Some(selector.to_string());
    }
    if selector.len() > 1
        && let Some(name) = selector.strip_suffix('!')
    {
        return slice_name_ok(name.as_bytes()).then(|| name.to_string());
    }
    if !is_prefix_selector(selector) {
        return None;
    }
    let prefix = &selector[..selector.len() - 1];
    selector_prefix_ok(prefix.as_bytes()).then(|| selector.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors() {
        for (s, want) in [
            ("*", true),
            ("book", true),
            ("patron:p1", true),
            ("chat:acme,*", true),
            ("chat:acme,gen.e~1", true),
            ("patron:p1.", true),
            ("", false),
            (":*", false),
            ("*:*", false),
            ("chat,*", false),
            ("chat*", false),
            ("chat::*", false),
            ("chat:ac*", false),
            ("chat:acme,,*", false),
            ("chat:a.b,*", false),
            ("chat:a.b,gen", false),
            ("chat:acme,", false),
            ("chat:,gen", false),
            ("chat:acme:generation", false),
            ("patron:", false),
            ("patron:p1!", false),
            ("pa~tron:p1", false),
            ("patron:p 1", false),
        ] {
            assert_eq!(valid_selector(s), want, "{s}");
        }

        // a slice name of SLICE_MAX bytes, the most there is, and one longer
        for (s, want) in [
            (format!("nope:{}", "a".repeat(505)), true),
            (format!("nope:{}", "a".repeat(506)), false),
            (format!("nope:{},*", "a".repeat(503)), true),
            (format!("nope:{},*", "a".repeat(504)), false),
        ] {
            assert_eq!(valid_selector(&s), want, "{} bytes", s.len());
        }
    }
}
