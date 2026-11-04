//! LMDB: the C API the store uses, declared by hand from lmdb.h, and an environment, its
//! transactions, and a cursor over them.  One environment holds one store, its keys in LMDB's
//! unnamed database, which compares them bytewise: the order of UTF-8 keys by code point.  Only
//! the engine thread ever opens it, so it opens without LMDB's lock file (MDB_NOLOCK).

#![allow(non_camel_case_types)]

use std::ffi::{CStr, CString, c_char, c_int, c_uint, c_void};
use std::ptr;

use phaselock_core::scan::{self, Cursor as _};

#[repr(C)]
pub struct MDB_env {
    _private: [u8; 0],
}

#[repr(C)]
pub struct MDB_txn {
    _private: [u8; 0],
}

#[repr(C)]
pub struct MDB_cursor {
    _private: [u8; 0],
}

type MDB_dbi = c_uint;

#[repr(C)]
#[derive(Clone, Copy)]
struct MDB_val {
    mv_size: usize,
    mv_data: *mut c_void,
}

#[repr(C)]
struct MDB_envinfo {
    me_mapaddr: *mut c_void,
    me_mapsize: usize,
    me_last_pgno: usize,
    me_last_txnid: usize,
    me_maxreaders: c_uint,
    me_numreaders: c_uint,
}

#[repr(C)]
struct MDB_stat {
    ms_psize: c_uint,
    ms_depth: c_uint,
    ms_branch_pages: usize,
    ms_leaf_pages: usize,
    ms_overflow_pages: usize,
    ms_entries: usize,
}

const MDB_RDONLY: c_uint = 0x20000;
const MDB_NOLOCK: c_uint = 0x400000;
const MDB_NOTFOUND: c_int = -30798;

// the cursor operations, as lmdb.h's MDB_cursor_op numbers them
const MDB_FIRST: c_int = 0;
const MDB_LAST: c_int = 6;
const MDB_NEXT: c_int = 8;
const MDB_PREV: c_int = 12;
const MDB_SET_RANGE: c_int = 17;

unsafe extern "C" {
    fn mdb_strerror(err: c_int) -> *const c_char;
    fn mdb_env_create(env: *mut *mut MDB_env) -> c_int;
    fn mdb_env_open(env: *mut MDB_env, path: *const c_char, flags: c_uint, mode: c_uint) -> c_int;
    fn mdb_env_close(env: *mut MDB_env);
    fn mdb_env_set_mapsize(env: *mut MDB_env, size: usize) -> c_int;
    fn mdb_env_info(env: *mut MDB_env, info: *mut MDB_envinfo) -> c_int;
    fn mdb_env_stat(env: *mut MDB_env, stat: *mut MDB_stat) -> c_int;
    fn mdb_txn_begin(
        env: *mut MDB_env,
        parent: *mut MDB_txn,
        flags: c_uint,
        txn: *mut *mut MDB_txn,
    ) -> c_int;
    fn mdb_txn_commit(txn: *mut MDB_txn) -> c_int;
    fn mdb_txn_abort(txn: *mut MDB_txn);
    fn mdb_dbi_open(
        txn: *mut MDB_txn,
        name: *const c_char,
        flags: c_uint,
        dbi: *mut MDB_dbi,
    ) -> c_int;
    fn mdb_get(txn: *mut MDB_txn, dbi: MDB_dbi, key: *mut MDB_val, data: *mut MDB_val) -> c_int;
    fn mdb_put(
        txn: *mut MDB_txn,
        dbi: MDB_dbi,
        key: *mut MDB_val,
        data: *mut MDB_val,
        flags: c_uint,
    ) -> c_int;
    fn mdb_del(txn: *mut MDB_txn, dbi: MDB_dbi, key: *mut MDB_val, data: *mut MDB_val) -> c_int;
    fn mdb_cursor_open(txn: *mut MDB_txn, dbi: MDB_dbi, cursor: *mut *mut MDB_cursor) -> c_int;
    fn mdb_cursor_close(cursor: *mut MDB_cursor);
    fn mdb_cursor_get(
        cursor: *mut MDB_cursor,
        key: *mut MDB_val,
        data: *mut MDB_val,
        op: c_int,
    ) -> c_int;
}

pub type Result<T> = std::result::Result<T, String>;

fn check(what: &str, rc: c_int) -> Result<()> {
    if rc == 0 {
        return Ok(());
    }
    let msg = unsafe { CStr::from_ptr(mdb_strerror(rc)) };
    Err(format!("lmdb {what}: {}", msg.to_string_lossy()))
}

fn val(b: &[u8]) -> MDB_val {
    MDB_val { mv_size: b.len(), mv_data: b.as_ptr() as *mut c_void }
}

const EMPTY: MDB_val = MDB_val { mv_size: 0, mv_data: ptr::null_mut() };

// the bytes an MDB_val points at, which last until the transaction writes or ends
unsafe fn bytes<'a>(v: MDB_val) -> &'a [u8] {
    if v.mv_size == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(v.mv_data.cast(), v.mv_size) }
    }
}

/// The map size an environment starts with, the most virtual address space it reserves: the
/// file grows as data does, and the map doubles once a write finds it three quarters full.
const MAP_START: usize = 1 << 30;

/// One store's LMDB environment, a directory holding its data file.
pub struct Env {
    env: *mut MDB_env,
    dbi: MDB_dbi,
    map_size: usize,
}

impl Env {
    /// Opens the store at dir, a directory that already exists, creating its data file when the
    /// directory holds none.
    pub fn open(dir: &str) -> Result<Env> {
        let path = CString::new(dir).map_err(|_| "lmdb open: the path holds U+0000".to_string())?;
        unsafe {
            let mut env = ptr::null_mut();
            check("env_create", mdb_env_create(&mut env))?;
            let mut e = Env { env, dbi: 0, map_size: MAP_START };
            check("set_mapsize", mdb_env_set_mapsize(env, MAP_START))?;
            check("env_open", mdb_env_open(env, path.as_ptr(), MDB_NOLOCK, 0o600))?;

            // the unnamed database, opened once in a transaction of its own
            let mut txn = ptr::null_mut();
            check("txn_begin", mdb_txn_begin(env, ptr::null_mut(), 0, &mut txn))?;
            let rc = mdb_dbi_open(txn, ptr::null(), 0, &mut e.dbi);
            if rc != 0 {
                mdb_txn_abort(txn);
                return check("dbi_open", rc).map(|_| e);
            }
            check("txn_commit", mdb_txn_commit(txn))?;
            Ok(e)
        }
    }

    /// Begins a transaction.  A write first doubles the map when the data has filled three
    /// quarters of it, which LMDB allows only while no transaction is open, as none is when the
    /// engine thread begins one.
    pub fn begin(&mut self, write: bool) -> Result<Txn> {
        unsafe {
            if write {
                self.grow()?;
            }
            let mut txn = ptr::null_mut();
            let flags = if write { 0 } else { MDB_RDONLY };
            check("txn_begin", mdb_txn_begin(self.env, ptr::null_mut(), flags, &mut txn))?;
            Ok(Txn { txn, dbi: self.dbi, write })
        }
    }

    unsafe fn grow(&mut self) -> Result<()> {
        unsafe {
            let mut info: MDB_envinfo = std::mem::zeroed();
            let mut stat: MDB_stat = std::mem::zeroed();
            check("env_info", mdb_env_info(self.env, &mut info))?;
            check("env_stat", mdb_env_stat(self.env, &mut stat))?;
            let used = (info.me_last_pgno + 1) * stat.ms_psize as usize;
            if used < self.map_size / 4 * 3 {
                return Ok(());
            }
            let size = self.map_size * 2;
            check("set_mapsize", mdb_env_set_mapsize(self.env, size))?;
            self.map_size = size;
            Ok(())
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        unsafe { mdb_env_close(self.env) }
    }
}

/// A transaction, aborted when it drops uncommitted.
pub struct Txn {
    txn: *mut MDB_txn,
    dbi: MDB_dbi,
    pub write: bool,
}

impl Txn {
    /// the value at key, None when the key is absent
    pub fn get(&self, key: &[u8]) -> Result<Option<&[u8]>> {
        if key.is_empty() {
            return Ok(None);
        }
        unsafe {
            let mut k = val(key);
            let mut d = EMPTY;
            match mdb_get(self.txn, self.dbi, &mut k, &mut d) {
                MDB_NOTFOUND => Ok(None),
                rc => check("get", rc).map(|_| Some(bytes(d))),
            }
        }
    }

    pub fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        unsafe {
            let mut k = val(key);
            let mut d = val(value);
            check("put", mdb_put(self.txn, self.dbi, &mut k, &mut d, 0))
        }
    }

    /// deletes key, answering whether it was there
    pub fn del(&mut self, key: &[u8]) -> Result<bool> {
        if key.is_empty() {
            return Ok(false);
        }
        unsafe {
            let mut k = val(key);
            match mdb_del(self.txn, self.dbi, &mut k, ptr::null_mut()) {
                MDB_NOTFOUND => Ok(false),
                rc => check("del", rc).map(|_| true),
            }
        }
    }

    /// every key under prefix, in order
    pub fn keys_under(&self, prefix: &[u8]) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        let mut cur = self.cursor(false)?;
        let mut at = cur.seek(false, Some(prefix), false)?;
        while at && cur.key().starts_with(prefix) {
            out.push(cur.key().to_vec());
            at = cur.step()?;
        }
        Ok(out)
    }

    /// a cursor over the transaction's keys, which reads values too when want_values
    pub fn cursor(&self, want_values: bool) -> Result<Cursor<'_>> {
        unsafe {
            let mut c = ptr::null_mut();
            check("cursor_open", mdb_cursor_open(self.txn, self.dbi, &mut c))?;
            Ok(Cursor { c, want_values, reverse: false, key: EMPTY, data: EMPTY, _txn: self })
        }
    }

    pub fn commit(mut self) -> Result<()> {
        let txn = std::mem::replace(&mut self.txn, ptr::null_mut());
        check("txn_commit", unsafe { mdb_txn_commit(txn) })
    }
}

impl Drop for Txn {
    fn drop(&mut self) {
        if !self.txn.is_null() {
            unsafe { mdb_txn_abort(self.txn) }
        }
    }
}

/// A cursor over a transaction's keys, the one a scan walks.  Its key and value are LMDB's own
/// pages, read in place.
pub struct Cursor<'t> {
    c: *mut MDB_cursor,
    want_values: bool,
    // the direction of the last seek, which a step keeps
    reverse: bool,
    key: MDB_val,
    data: MDB_val,
    _txn: &'t Txn,
}

impl Cursor<'_> {
    // one cursor operation, positioning the cursor at its answer; false at the end of the keys
    fn op(&mut self, op: c_int, target: Option<&[u8]>) -> Result<bool> {
        if let Some(t) = target {
            self.key = val(t);
        }
        match unsafe { mdb_cursor_get(self.c, &mut self.key, &mut self.data, op) } {
            MDB_NOTFOUND => {
                self.key = EMPTY;
                Ok(false)
            }
            rc => check("cursor_get", rc).map(|_| true),
        }
    }
}

impl scan::Cursor for Cursor<'_> {
    fn seek(&mut self, reverse: bool, target: Option<&[u8]>, strict: bool) -> Result<bool> {
        self.reverse = reverse;
        let target = target.filter(|t| !t.is_empty());
        match (target, reverse) {
            (None, false) => self.op(MDB_FIRST, None),
            (None, true) => self.op(MDB_LAST, None),

            // forward: the first key at or after the target, then past it when strict
            (Some(t), false) => {
                let at = self.op(MDB_SET_RANGE, Some(t))?;
                if at && strict && self.key() == t { self.op(MDB_NEXT, None) } else { Ok(at) }
            }

            // reverse: the first key at or after the target, then back one unless it is the
            // target itself and the seek may stop there; past every key, the last key
            (Some(t), true) => {
                if !self.op(MDB_SET_RANGE, Some(t))? {
                    return self.op(MDB_LAST, None);
                }
                if !strict && self.key() == t { Ok(true) } else { self.op(MDB_PREV, None) }
            }
        }
    }

    fn step(&mut self) -> Result<bool> {
        self.op(if self.reverse { MDB_PREV } else { MDB_NEXT }, None)
    }

    fn key(&self) -> &[u8] {
        unsafe { bytes(self.key) }
    }

    fn value(&self) -> &[u8] {
        if self.want_values { unsafe { bytes(self.data) } } else { &[] }
    }
}

impl Drop for Cursor<'_> {
    fn drop(&mut self) {
        unsafe { mdb_cursor_close(self.c) }
    }
}
