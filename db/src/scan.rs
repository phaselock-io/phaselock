//! Key patterns: the skeleton's KeyPattern compiled from the bundle's object, the skip-scan walk
//! of the keys a pattern picks out over the kv cursor, and the spans the grantor's scans read.  It
//! follows the skeleton's "key patterns" section step for step.  Keys and bounds are UTF-8 and
//! compare bytewise, which is code-point order, the order the skeleton's comparisons keep.  A
//! bound's successor is its last byte incremented, and no valid key lies between that and the
//! skeleton's code-point successor.

use std::cmp::Ordering;

use crate::js::{self, ffi::*};
use crate::store::{Cursor, prefix_bound};

/// the keys a walk steps through before it seeks: a SQLite seek costs about as much as 16 steps
pub const SCAN_STEP_BUDGET: usize = 16;

/// A field of a compiled pattern, in key order: a literal, the local template's name with the ':'
/// after it when it has parameters, matched as text; or a value field per parameter, with its
/// bounds and the separator after it (0 after the last one of a key).
#[derive(Clone, PartialEq, Eq, Default, Debug)]
struct Field {
    literal: bool,
    lit: Vec<u8>,
    whole: bool, // the literal is a whole local key
    lo: Option<Vec<u8>>,
    hi: Option<Vec<u8>>,
    lo_open: bool,
    hi_open: bool,
    single: bool, // the field admits one value only
    sep: u8,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Pattern {
    head: Vec<u8>, // the text every key the pattern picks out starts with
    fields: Vec<Field>,
    named: bool,
}

// compiling //////////////////////////////////////////////////////////////////

/// the text of a property of obj, None when it is undefined; Err with the exception pending
fn prop_text(
    ctx: *mut JSContext,
    obj: JSValue,
    name: &std::ffi::CStr,
) -> Result<Option<Vec<u8>>, ()> {
    let v = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, obj, name.as_ptr()) });
    if is_exception(v.v) {
        return Err(());
    }
    if is_undefined(v.v) {
        return Ok(None);
    }
    js::text_of(ctx, v.v).map(Some).ok_or(())
}

// the length of an array, or Err with an exception when v is not one
fn array_length(ctx: *mut JSContext, v: JSValue, what: &str) -> Result<i64, ()> {
    if unsafe { JS_IsArray(ctx, v) } != 1 {
        js::throw_type(ctx, &format!("{what} is an array of parameter matches"));
        return Err(());
    }
    let lenv = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, v, c"length".as_ptr()) });
    let mut n = -1i64;
    if unsafe { JS_ToInt64(ctx, &mut n, lenv.v) } != 0 {
        return Err(());
    }
    Ok(n)
}

impl Pattern {
    // the skeleton's valueField: a value field matching m, followed by sep
    fn value_field(&mut self, ctx: *mut JSContext, m: JSValue, sep: u8) -> Result<(), ()> {
        let mut f = Field { sep, ..Default::default() };

        // the bounds of each kind of match; a range keeps the tighter of each pair it gives
        if is_null(m) {
            self.fields.push(f);
            return Ok(());
        }
        if !is_object(m) {
            js::throw_type(ctx, "a parameter match is null or an object");
            return Err(());
        }
        let has_eq = js::has_prop(ctx, m, "eq");
        let has_prefix = if has_eq != 0 { 0 } else { js::has_prop(ctx, m, "prefix") };
        if has_eq < 0 || has_prefix < 0 {
            return Err(());
        }
        if has_eq != 0 {
            f.lo = prop_text(ctx, m, c"eq")?;
            f.hi = f.lo.clone();
            f.single = true;
        } else if has_prefix != 0 {
            let Some(pre) = prop_text(ctx, m, c"prefix")? else {
                js::throw_type(ctx, "a prefix match names its prefix");
                return Err(());
            };
            if !pre.is_empty() {
                f.hi = prefix_bound(&pre);
                f.lo = Some(pre);
                f.hi_open = true;
            }
        } else {
            f.lo = prop_text(ctx, m, c"gte")?;
            let gt = prop_text(ctx, m, c"gt")?;
            f.hi = prop_text(ctx, m, c"lte")?;
            let lt = prop_text(ctx, m, c"lt")?;
            if let Some(gt) = gt
                && f.lo.as_ref().is_none_or(|lo| gt >= *lo)
            {
                f.lo = Some(gt);
                f.lo_open = true;
            }
            if let Some(lt) = lt
                && f.hi.as_ref().is_none_or(|hi| lt <= *hi)
            {
                f.hi = Some(lt);
                f.hi_open = true;
            }
        }
        self.fields.push(f);
        Ok(())
    }

    // a value field per match in arr, each followed by sep and the last by last
    fn value_fields(
        &mut self,
        ctx: *mut JSContext,
        arr: JSValue,
        n: i64,
        sep: u8,
        last: u8,
    ) -> Result<(), ()> {
        for i in 0..n {
            let m = js::Owned::new(ctx, unsafe { JS_GetPropertyUint32(ctx, arr, i as u32) });
            if is_exception(m.v) {
                return Err(());
            }
            self.value_field(ctx, m.v, if i < n - 1 { sep } else { last })?;
        }
        Ok(())
    }

    // the head and slice fields of a KeyPattern's slice: one by name, or a family's with a field
    // per parameter
    fn slice_fields(&mut self, ctx: *mut JSContext, s: JSValue) -> Result<(), ()> {
        // one slice by name
        if is_string(s) {
            let mut name = js::text_of(ctx, s).ok_or(())?;
            name.push(b'!');
            self.head = name;
            return Ok(());
        }
        if !is_object(s) {
            js::throw_type(ctx, "a pattern's slice is a name, a family, or null");
            return Err(());
        }

        // a family's slices, with a field per parameter
        let fam = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, s, c"family".as_ptr()) });
        let params = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, s, c"params".as_ptr()) });
        if is_exception(fam.v) {
            return Err(());
        }
        let mut family = js::text_of(ctx, fam.v).ok_or(())?;
        let n = array_length(ctx, params.v, "a family pattern's params")?;
        if n < 0 {
            return Err(());
        }
        family.push(if n == 0 { b'!' } else { b':' });
        self.head = family;
        self.value_fields(ctx, params.v, n, b',', b'!')
    }

    /// the skeleton's compilePattern of a KeyPattern; Err with a JS exception for a malformed one
    pub(crate) fn from_js(ctx: *mut JSContext, v: JSValue) -> Result<Pattern, ()> {
        let mut p = Pattern { head: Vec::new(), fields: Vec::new(), named: false };
        if !is_object(v) {
            js::throw_type(ctx, "a scan's pattern is an object");
            return Err(());
        }
        let s = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, v, c"slice".as_ptr()) });
        let name = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, v, c"name".as_ptr()) });
        let local = js::Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, v, c"local".as_ptr()) });
        let n = array_length(ctx, local.v, "a pattern's local")?;
        if n < 0 {
            return Err(());
        }
        if !is_null(name.v) && !is_string(name.v) {
            js::throw_type(ctx, "a pattern's name is a string or null");
            return Err(());
        }

        // every key
        if is_null(s.v) {
            if !is_null(name.v) || n > 0 {
                js::throw_error(ctx, "a pattern over every slice picks out every local key");
                return Err(());
            }
            return Ok(p);
        }

        // the slices: one by name, or a family's with a field per parameter
        p.slice_fields(ctx, s.v)?;

        // every local key of the slices, or one template's, its name a literal
        if is_null(name.v) {
            if n > 0 {
                js::throw_error(ctx, "a pattern over every local key matches no parameter");
                return Err(());
            }
            return Ok(p);
        }
        let mut tname = js::text_of(ctx, name.v).ok_or(())?;
        if n > 0 {
            tname.push(b':');
        }
        p.fields.push(Field { literal: true, lit: tname, whole: n == 0, ..Default::default() });
        p.named = true;
        p.value_fields(ctx, local.v, n, b',', 0)?;
        Ok(p)
    }

    /// whether the pattern names a local template, so that its keys share one type
    pub fn named(&self) -> bool {
        self.named
    }

    /// whether the pattern picks out a key
    pub fn matches(&self, key: &[u8]) -> bool {
        matches!(self.place(key, false), Place::Match)
    }
}

// placing a key //////////////////////////////////////////////////////////////

/// where a key stands against a pattern, for a walk one way: a match, a key to step past, the end
/// of the walk, or the target of a seek to the next key that may match
enum Place {
    Match,
    Step,
    Done,
    Seek(Vec<u8>, bool),
}

fn seek_to(key: &[u8], at: usize, tail: &[u8], strict: bool) -> Place {
    let mut t = key[..at].to_vec();
    t.extend_from_slice(tail);
    Place::Seek(t, strict)
}

impl Pattern {
    // past every key holding the value of the nearest varying field before field i
    fn skip_back(&self, i: usize, ends: &[usize], key: &[u8], reverse: bool) -> Place {
        for j in (0..i).rev() {
            let f = &self.fields[j];
            if f.literal || f.single {
                continue;
            }
            if reverse {
                return seek_to(key, ends[j] + 1, b"", true);
            }
            return seek_to(key, ends[j], &[f.sep.wrapping_add(1)], false);
        }
        Place::Done
    }

    /* Places a key the way a skip scan does: the skeleton's placeKey.  The first field outside its
    match decides: a field short of its match seeks to where the match begins, and a field past
    it seeks past every key holding the value of the nearest field before it that admits more
    than one, or ends the walk when no such field does.  Seek targets are in walk order. */
    fn place(&self, key: &[u8], reverse: bool) -> Place {
        if !key.starts_with(&self.head) {
            return Place::Done;
        }
        let mut ends = vec![0usize; self.fields.len()];
        let mut pos = self.head.len();
        for (i, f) in self.fields.iter().enumerate() {
            // a literal: the template's keys start with it, or are it when it is a whole local key
            if f.literal {
                let rest = &key[pos..];
                if rest.starts_with(&f.lit) && (!f.whole || key.len() == pos + f.lit.len()) {
                    pos += f.lit.len();
                    continue;
                }
                if rest.cmp(&f.lit[..]) == Ordering::Less {
                    if reverse {
                        return self.skip_back(i, &ends, key, reverse);
                    }
                    return seek_to(key, pos, &f.lit, false);
                }
                if !reverse {
                    return self.skip_back(i, &ends, key, reverse);
                }
                if f.whole {
                    return seek_to(key, pos, &f.lit, false);
                }
                let end = prefix_bound(&f.lit).unwrap_or_default();
                return seek_to(key, pos, &end, true);
            }

            // a value field: its text runs to its separator, or to the end for the last field
            let mut end = key.len();
            let mut short = false;
            if f.sep != 0 {
                match key[pos..].iter().position(|&c| c == f.sep) {
                    Some(at) => end = pos + at,
                    None => short = true,
                }
            }
            let v = &key[pos..end];

            // is the value short of its match?
            if let Some(lo) = &f.lo {
                let d = v.cmp(lo);
                if d == Ordering::Less || (d == Ordering::Equal && f.lo_open) {
                    if reverse {
                        return self.skip_back(i, &ends, key, reverse);
                    }
                    if !f.lo_open {
                        return seek_to(key, pos, lo, false);
                    }
                    if f.sep == 0 {
                        return seek_to(key, pos, lo, true);
                    }
                    let mut t = lo.clone();
                    t.push(f.sep + 1);
                    return seek_to(key, pos, &t, false);
                }
            }

            // is it past its match?
            if let Some(hi) = &f.hi {
                let d = v.cmp(hi);
                if d == Ordering::Greater || (d == Ordering::Equal && f.hi_open) {
                    if !reverse {
                        return self.skip_back(i, &ends, key, reverse);
                    }
                    if f.hi_open {
                        return seek_to(key, pos, hi, true);
                    }
                    if f.sep == 0 {
                        return seek_to(key, pos, hi, false);
                    }
                    let mut t = hi.clone();
                    t.push(f.sep + 1);
                    return seek_to(key, pos, &t, true);
                }
            }

            // inside its match, but a key that ends here holds none of the fields after it
            if short {
                return Place::Step;
            }
            ends[i] = end;
            pos = end + (f.sep != 0) as usize;
        }
        Place::Match
    }
}

// walking ////////////////////////////////////////////////////////////////////

/// what a walk's visit answers for a key
pub enum Visit {
    Next,
    Stop,
    Fail,
}

// whether the walk has reached a seek's target with the cursor at key
fn past(target: &[u8], strict: bool, key: &[u8], reverse: bool) -> bool {
    let d = if reverse { target.cmp(key) } else { key.cmp(target) };
    d == Ordering::Greater || (d == Ordering::Equal && !strict)
}

/// Walks the keys a pattern picks out: the skeleton's walkPattern, from just past after when it
/// is given.  Before a seek the walk steps up to budget keys toward the target, since a seek costs
/// more than a few steps over the short gaps between matches.  visit sees each key and its value;
/// a visit's failure fails the walk, as the store's does.
pub fn walk(
    cur: &mut Cursor<'_>,
    p: &Pattern,
    reverse: bool,
    after: Option<&[u8]>,
    budget: usize,
    mut visit: impl FnMut(&[u8], &[u8]) -> Visit,
) -> Result<(), String> {
    // start just past after, or at the pattern's first key in walk order
    let mut at = match after {
        Some(a) => cur.seek(reverse, Some(a), true)?,
        None if !reverse => cur.seek(false, Some(&p.head), false)?,
        None => {
            let end = prefix_bound(&p.head);
            cur.seek(true, end.as_deref(), end.is_some())?
        }
    };
    while at {
        let place = p.place(cur.key(), reverse);
        let (target, strict) = match place {
            Place::Done => break,
            Place::Match => {
                match visit(cur.key(), cur.value()) {
                    Visit::Next => {}
                    Visit::Stop => break,
                    Visit::Fail => return Err("the walk's visit failed".into()),
                }
                at = cur.step()?;
                continue;
            }
            Place::Step => {
                at = cur.step()?;
                continue;
            }
            Place::Seek(t, s) => (t, s),
        };

        // a target behind the key comes from a bound holding characters its parameter cannot,
        // which orders differently against the separators; stepping is always safe
        if past(&target, strict, cur.key(), reverse) {
            at = cur.step()?;
            continue;
        }

        // step toward the target, then seek if it is still ahead
        let mut i = 0;
        while i < budget {
            at = cur.step()?;
            if !at || past(&target, strict, cur.key(), reverse) {
                break;
            }
            i += 1;
        }
        if i == budget {
            at = cur.seek(reverse, Some(&target), strict)?;
        }
    }
    Ok(())
}

// spans //////////////////////////////////////////////////////////////////////

/// What one scan batch walked, the skeleton's ScanSpan: its pattern, and the stretch of keys from
/// just past from, or the walk's start when it is None, to to, or the walk's end.
pub struct Span {
    pattern: Pattern,
    reverse: bool,
    from: Option<Vec<u8>>,
    to: Option<Vec<u8>>,
}

/// Adds a span; the next batch of the last span's walk, resuming where it ends under the same
/// pattern, extends that span instead.
pub fn push_span(
    l: &mut Vec<Span>,
    pattern: Pattern,
    reverse: bool,
    from: Option<&[u8]>,
    to: Option<&[u8]>,
) {
    if let Some(last) = l.last_mut()
        && let Some(from) = from
        && last.to.as_deref() == Some(from)
        && last.reverse == reverse
        && last.pattern == pattern
    {
        last.to = to.map(|t| t.to_vec());
        return;
    }
    l.push(Span { pattern, reverse, from: from.map(|f| f.to_vec()), to: to.map(|t| t.to_vec()) });
}

impl Span {
    /// whether a key written lies inside what the scan batch read
    pub fn covers(&self, key: &[u8]) -> bool {
        if let Some(from) = &self.from {
            let d = key.cmp(from);
            if if self.reverse { d != Ordering::Less } else { d != Ordering::Greater } {
                return false;
            }
        }
        if let Some(to) = &self.to {
            let d = key.cmp(to);
            if if self.reverse { d == Ordering::Less } else { d == Ordering::Greater } {
                return false;
            }
        }
        self.pattern.matches(key)
    }

    /* Whether a key under prefix could lie inside what the scan batch read.  Every key under the
    prefix lies in one stretch of key order, and every key the span covers starts with the
    pattern's head and lies in the stretch its walk covered.  So a key under the prefix can lie
    inside the span only when the prefix and the head agree, one starting with the other, and
    the two stretches overlap.  Within that, the span is taken to hold the key. */
    pub fn may_hold(&self, prefix: &[u8]) -> bool {
        let h = &self.pattern.head;
        if !prefix.starts_with(h) && !h.starts_with(prefix) {
            return false;
        }

        // the stretch's bounds in key order: forward from past from to to, reversed from to to
        // short of from
        let (lo, hi) = if self.reverse { (&self.to, &self.from) } else { (&self.from, &self.to) };
        let hi_open = self.reverse;

        // the least key under the prefix is the prefix itself, which must lie below the upper
        // bound
        if let Some(hi) = hi {
            let d = prefix.cmp(hi);
            if d == Ordering::Greater || (d == Ordering::Equal && hi_open) {
                return false;
            }
        }

        // some key under the prefix lies above the lower bound unless the bound is above them all
        if let Some(lo) = lo
            && lo.as_slice() > prefix
            && !lo.starts_with(prefix)
        {
            return false;
        }
        true
    }
}
