//! SQLite storage: the KV store, the edit log, the series table, the token keys, and the slices
//! table live in one database file.  Keys and slice names are TEXT compared bytewise, bound from
//! their bytes as they are.

use std::cell::{RefCell, RefMut};
use std::ffi::{CStr, c_int};
use std::ptr::{self, NonNull};

use phaselock_core::scan::{self, prefix_bound};
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, ToSql, ffi, params};

const SCHEMA: &str = "
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS log (position INTEGER NOT NULL, slice TEXT NOT NULL,
      seq INTEGER NOT NULL, lifecycle INTEGER NOT NULL, edit BLOB NOT NULL,
      PRIMARY KEY (position, slice)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS log_slice ON log(slice, position);
    CREATE TABLE IF NOT EXISTS series (key TEXT PRIMARY KEY, hwm INTEGER NOT NULL,
      time INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS token_keys (kid TEXT PRIMARY KEY, public BLOB NOT NULL,
      minted INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS slices (name TEXT PRIMARY KEY, birth INTEGER NOT NULL,
      death INTEGER, seq INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0,
      edit_bytes INTEGER NOT NULL DEFAULT 0, state_bytes INTEGER NOT NULL DEFAULT 0)
      WITHOUT ROWID;";

pub type Result<T> = std::result::Result<T, String>;

fn err(what: &str, e: rusqlite::Error) -> String {
    format!("{what}: {e}")
}

/// text bound from its bytes, which SQLite compares bytewise
struct T<'a>(&'a [u8]);

impl ToSql for T<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(self.0)))
    }
}

fn bytes(r: &rusqlite::Row<'_>, i: usize) -> rusqlite::Result<Vec<u8>> {
    Ok(r.get_ref(i)?.as_bytes().map(|b| b.to_vec()).unwrap_or_default())
}

/// one row of the log: the position of its mutation, the slice it edits, and its wire encoding
pub struct LogRow {
    pub position: u64,
    pub slice: String,
    pub edit: Vec<u8>,
}

/// one row of the slices table
pub struct SliceRow {
    pub name: String,
    pub seq: u64,
    pub pos: u64,
    pub live: bool,
}

/// a slice's counters: its last edit's position, and its byte counters
pub struct SliceStats {
    pub pos: u64,
    pub edit_bytes: u64,
    pub state_bytes: u64,
}

pub struct TokenKeyRow {
    pub kid: String,
    pub public: Vec<u8>,
    pub minted: i64,
}

/// One SQLite connection, the writer's or the reader's.
pub struct Store {
    // ahead of conn, so that the statements are finalized before the connection closes
    seeks: RefCell<Seeks>,
    conn: Connection,
}

impl Store {
    /// Opens the database at path with a page cache of cache_mib MiB, or SQLite's own default
    /// size for 0; the writer makes the schema.
    pub fn open(path: &str, writer: bool, cache_mib: i64) -> Result<Store> {
        let conn = Connection::open(path).map_err(|e| format!("open {path}: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_millis(5000)).map_err(|e| err("busy", e))?;
        conn.set_prepared_statement_cache_capacity(64);
        if writer {
            conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
                .map_err(|e| err("journal_mode", e))?;
            conn.execute_batch(SCHEMA).map_err(|e| err("schema", e))?;
        }

        // the page cache, which SQLite sizes in KiB when the size is negative
        if cache_mib > 0 {
            conn.execute_batch(&format!("PRAGMA cache_size=-{};", cache_mib * 1024))
                .map_err(|e| err("cache_size", e))?;
        }
        let seeks = Seeks::prepare(&conn)?;
        Ok(Store { seeks: RefCell::new(seeks), conn })
    }

    pub fn exec(&self, sql: &str) -> Result<()> {
        self.conn.execute_batch(sql).map_err(|e| err(sql, e))
    }

    pub fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT value FROM kv WHERE key = ?1")
            .map_err(|e| err("get", e))?;
        st.query_row([T(key)], |r| bytes(r, 0)).optional().map_err(|e| err("get", e))
    }

    // the stored size of key, counting key and value bytes
    fn stored_size(&self, key: &[u8]) -> Result<Option<i64>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT length(value) FROM kv WHERE key = ?1")
            .map_err(|e| err("kv_len", e))?;
        let n: Option<i64> =
            st.query_row([T(key)], |r| r.get(0)).optional().map_err(|e| err("kv_len", e))?;
        Ok(n.map(|n| n + key.len() as i64))
    }

    // charge delta bytes of state to the slice owning key, the text before its first '!'
    fn charge_state(&self, key: &[u8], delta: i64) -> Result<()> {
        if delta == 0 {
            return Ok(());
        }
        let Some(bang) = key.iter().position(|&c| c == b'!') else { return Ok(()) };
        let mut st = self
            .conn
            .prepare_cached("UPDATE slices SET state_bytes = state_bytes + ?2 WHERE name = ?1")
            .map_err(|e| err("slice_charge", e))?;
        st.execute(params![T(&key[..bang]), delta]).map_err(|e| err("slice_charge", e))?;
        Ok(())
    }

    pub fn set(&self, key: &[u8], val: &[u8]) -> Result<()> {
        let before = self.stored_size(key)?;
        let mut st = self
            .conn
            .prepare_cached("INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)")
            .map_err(|e| err("set", e))?;
        st.execute(params![T(key), val]).map_err(|e| err("set", e))?;
        let after = (val.len() + key.len()) as i64;
        self.charge_state(key, after - before.unwrap_or(0))
    }

    pub fn del(&self, key: &[u8]) -> Result<()> {
        let before = self.stored_size(key)?;
        let mut st =
            self.conn.prepare_cached("DELETE FROM kv WHERE key = ?1").map_err(|e| err("del", e))?;
        st.execute([T(key)]).map_err(|e| err("del", e))?;
        match before {
            Some(b) => self.charge_state(key, -b),
            None => Ok(()),
        }
    }

    /// every key under prefix, in key order, with its value
    pub fn scan(&self, prefix: &[u8], mut f: impl FnMut(&[u8], &[u8])) -> Result<()> {
        let bound = prefix_bound(prefix);
        let sql = match bound {
            Some(_) => "SELECT key, value FROM kv WHERE key >= ?1 AND key < ?2 ORDER BY key",
            None => "SELECT key, value FROM kv ORDER BY key",
        };
        let mut st = self.conn.prepare_cached(sql).map_err(|e| err("scan", e))?;
        let mut rows = match &bound {
            Some(b) => st.query(params![T(prefix), T(b)]),
            None => st.query([]),
        }
        .map_err(|e| err("scan", e))?;
        while let Some(r) = rows.next().map_err(|e| err("scan", e))? {
            let k = r.get_ref(0).map_err(|e| err("scan", e))?.as_bytes().unwrap_or(b"");
            let v = r.get_ref(1).map_err(|e| err("scan", e))?.as_bytes().unwrap_or(b"");
            f(k, v);
        }
        Ok(())
    }

    pub fn del_prefix(&self, prefix: &[u8]) -> Result<()> {
        let Some(bound) = prefix_bound(prefix) else { return self.exec("DELETE FROM kv") };
        let mut st = self
            .conn
            .prepare_cached("DELETE FROM kv WHERE key >= ?1 AND key < ?2")
            .map_err(|e| err("del_prefix", e))?;
        st.execute(params![T(prefix), T(&bound)]).map_err(|e| err("del_prefix", e))?;
        if prefix.len() > 1 && prefix.ends_with(b"!") {
            let mut st = self
                .conn
                .prepare_cached("UPDATE slices SET state_bytes = 0 WHERE name = ?1")
                .map_err(|e| err("slice_charge_zero", e))?;
            st.execute([T(&prefix[..prefix.len() - 1])])
                .map_err(|e| err("slice_charge_zero", e))?;
        }
        Ok(())
    }

    /// A log row is one edit: the position of its mutation, the slice it edits, its seq there,
    /// its lifecycle, and its wire encoding whole.
    pub fn append(
        &self,
        position: u64,
        slice: &str,
        seq: u64,
        lifecycle: u8,
        edit: &[u8],
    ) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached(
                "INSERT INTO log (position, slice, seq, lifecycle, edit) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| err("append", e))?;
        st.execute(params![position as i64, slice, seq as i64, lifecycle, edit])
            .map_err(|e| err("append", e))?;
        Ok(())
    }

    // every row of a log read to f, until f answers false
    fn log_rows(
        &self,
        sql: &str,
        p: &[&dyn ToSql],
        what: &str,
        mut f: impl FnMut(LogRow) -> bool,
    ) -> Result<()> {
        let mut st = self.conn.prepare_cached(sql).map_err(|e| err(what, e))?;
        let mut rows = st.query(p).map_err(|e| err(what, e))?;
        while let Some(r) = rows.next().map_err(|e| err(what, e))? {
            let row = LogRow {
                position: r.get::<_, i64>(0).map_err(|e| err(what, e))? as u64,
                slice: String::from_utf8_lossy(&bytes(r, 1).map_err(|e| err(what, e))?)
                    .into_owned(),
                edit: bytes(r, 2).map_err(|e| err(what, e))?,
            };
            if !f(row) {
                break;
            }
        }
        Ok(())
    }

    /// the edits with from <= position <= to, by position, then slice
    pub fn read_log(&self, from: u64, to: u64, f: impl FnMut(LogRow) -> bool) -> Result<()> {
        self.log_rows(
            "SELECT position, slice, edit FROM log WHERE position >= ?1 AND position <= ?2 \
             ORDER BY position, slice",
            &[&(from as i64), &(to.min(i64::MAX as u64) as i64)],
            "read_log",
            f,
        )
    }

    /// the edits of one slice with from < position < to, ascending or descending
    pub fn read_slice(
        &self,
        slice: &str,
        from: u64,
        to: u64,
        reverse: bool,
        f: impl FnMut(LogRow) -> bool,
    ) -> Result<()> {
        let sql = if reverse {
            "SELECT position, slice, edit FROM log \
             WHERE slice = ?1 AND position > ?2 AND position < ?3 ORDER BY position DESC"
        } else {
            "SELECT position, slice, edit FROM log \
             WHERE slice = ?1 AND position > ?2 AND position < ?3 ORDER BY position"
        };
        self.log_rows(
            sql,
            &[&slice, &(from as i64), &(to.min(i64::MAX as u64) as i64)],
            "read_slice",
            f,
        )
    }

    /// The edits of the slices whose names start with prefix, with from < position < to, by
    /// position ascending or descending, then by slice in the same direction.  It walks the log's
    /// own order, filtered by prefix, since the (slice, position) index would range the prefix and
    /// then sort every edit in it.
    pub fn read_prefix(
        &self,
        prefix: &str,
        from: u64,
        to: u64,
        reverse: bool,
        f: impl FnMut(LogRow) -> bool,
    ) -> Result<()> {
        let sql = if reverse {
            "SELECT position, slice, edit FROM log NOT INDEXED WHERE position > ?1 AND position < ?2 \
             AND slice >= ?3 AND slice < ?4 ORDER BY position DESC, slice DESC"
        } else {
            "SELECT position, slice, edit FROM log NOT INDEXED WHERE position > ?1 AND position < ?2 \
             AND slice >= ?3 AND slice < ?4 ORDER BY position, slice"
        };
        // slice names are ASCII, so DEL bounds the empty prefix
        let bound = prefix_bound(prefix.as_bytes()).unwrap_or_else(|| vec![0x7f]);
        self.log_rows(
            sql,
            &[&(from as i64), &(to.min(i64::MAX as u64) as i64), &prefix, &T(&bound)],
            "read_prefix",
            f,
        )
    }

    pub fn max_position(&self) -> Result<u64> {
        let mut st = self
            .conn
            .prepare_cached("SELECT COALESCE(MAX(position), 0) FROM log")
            .map_err(|e| err("max_position", e))?;
        st.query_row([], |r| r.get::<_, i64>(0))
            .map(|p| p as u64)
            .map_err(|e| err("max_position", e))
    }

    /// The series table, keyed by the hex SHA-256 of a series: the series' mark, when it is known.
    pub fn series_hwm(&self, key: &str) -> Result<Option<u64>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT hwm FROM series WHERE key = ?1")
            .map_err(|e| err("series_hwm", e))?;
        st.query_row([key], |r| r.get::<_, i64>(0))
            .optional()
            .map(|h| h.map(|h| h as u64))
            .map_err(|e| err("series_hwm", e))
    }

    /// raises the series' mark to n at least, and stamps its last decision
    pub fn series_mark(&self, key: &str, n: u64, time: i64) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached(
                "INSERT INTO series (key, hwm, time) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (key) DO UPDATE SET hwm = MAX(hwm, excluded.hwm), time = excluded.time",
            )
            .map_err(|e| err("series_mark", e))?;
        st.execute(params![key, n as i64, time]).map_err(|e| err("series_mark", e))?;
        Ok(())
    }

    /// every token key, oldest first
    pub fn keys(&self) -> Result<Vec<TokenKeyRow>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT kid, public, minted FROM token_keys ORDER BY minted, kid")
            .map_err(|e| err("keys", e))?;
        let rows = st
            .query_map([], |r| {
                Ok(TokenKeyRow { kid: r.get(0)?, public: r.get(1)?, minted: r.get(2)? })
            })
            .map_err(|e| err("keys", e))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| err("keys", e))
    }

    pub fn key_add(&self, kid: &str, public: &[u8], minted: i64) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached("INSERT INTO token_keys (kid, public, minted) VALUES (?1, ?2, ?3)")
            .map_err(|e| err("key_add", e))?;
        st.execute(params![kid, public, minted]).map_err(|e| err("key_add", e))?;
        Ok(())
    }

    pub fn key_del(&self, kid: &str) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached("DELETE FROM token_keys WHERE kid = ?1")
            .map_err(|e| err("key_del", e))?;
        st.execute([kid]).map_err(|e| err("key_del", e))?;
        Ok(())
    }

    /// A birth creates or revives the slice's row, and comes before the slice's first next_seq.
    pub fn slice_birth(&self, name: &str, pos: u64) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached(
                "INSERT INTO slices (name, birth, seq) VALUES (?1, ?2, 0) \
                 ON CONFLICT (name) DO UPDATE SET birth = excluded.birth, death = NULL",
            )
            .map_err(|e| err("slice_birth", e))?;
        st.execute(params![name, pos as i64]).map_err(|e| err("slice_birth", e))?;
        Ok(())
    }

    pub fn slice_death(&self, name: &str, pos: u64) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached("UPDATE slices SET death = ?2 WHERE name = ?1 AND death IS NULL")
            .map_err(|e| err("slice_death", e))?;
        st.execute(params![name, pos as i64]).map_err(|e| err("slice_death", e))?;
        Ok(())
    }

    /// the slice's edits below the position go, and its edit bytes are those of the edits that
    /// remain
    pub fn slice_erase(&self, name: &str, before: u64) -> Result<()> {
        let mut st = self
            .conn
            .prepare_cached("DELETE FROM log WHERE slice = ?1 AND position < ?2")
            .map_err(|e| err("slice_erase", e))?;
        st.execute(params![name, before as i64]).map_err(|e| err("slice_erase", e))?;
        let mut st = self
            .conn
            .prepare_cached(
                "UPDATE slices SET edit_bytes = (SELECT COALESCE(SUM(length(edit)), 0) \
                 FROM log WHERE slice = ?1) WHERE name = ?1",
            )
            .map_err(|e| err("slice_bytes", e))?;
        st.execute([name]).map_err(|e| err("slice_bytes", e))?;
        Ok(())
    }

    /// the slice's next seq, for an edit at pos, charging the edit's bytes to it
    pub fn slice_next_seq(&self, name: &str, nbytes: usize, pos: u64) -> Result<u64> {
        let mut st = self
            .conn
            .prepare_cached(
                "UPDATE slices SET seq = seq + 1, pos = ?3, edit_bytes = edit_bytes + ?2 \
                 WHERE name = ?1 RETURNING seq",
            )
            .map_err(|e| err("slice_next_seq", e))?;
        st.query_row(params![name, nbytes as i64, pos as i64], |r| r.get::<_, i64>(0))
            .map(|s| s as u64)
            .map_err(|e| err("slice_next_seq", e))
    }

    /// the slice's seq and whether it is live, when it has a row; (0, false) when never born
    pub fn slice_state(&self, name: &[u8]) -> Result<(u64, bool)> {
        let mut st = self
            .conn
            .prepare_cached("SELECT seq, death IS NULL FROM slices WHERE name = ?1")
            .map_err(|e| err("slice_state", e))?;
        let r = st
            .query_row([T(name)], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? != 0)))
            .optional()
            .map_err(|e| err("slice_state", e))?;
        Ok(r.unwrap_or((0, false)))
    }

    pub fn slice_stats(&self, name: &str) -> Result<Option<SliceStats>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT pos, edit_bytes, state_bytes FROM slices WHERE name = ?1")
            .map_err(|e| err("slice_stats", e))?;
        st.query_row([name], |r| {
            Ok(SliceStats {
                pos: r.get::<_, i64>(0)? as u64,
                edit_bytes: r.get::<_, i64>(1)? as u64,
                state_bytes: r.get::<_, i64>(2)? as u64,
            })
        })
        .optional()
        .map_err(|e| err("slice_stats", e))
    }

    /// every slice ever born whose name starts with prefix, by name
    pub fn slices_under(&self, prefix: &str) -> Result<Vec<SliceRow>> {
        let bound = prefix_bound(prefix.as_bytes());
        let sql = match bound {
            Some(_) => {
                "SELECT name, seq, pos, death IS NULL FROM slices WHERE name >= ?1 AND name < ?2 \
                 ORDER BY name"
            }
            None => "SELECT name, seq, pos, death IS NULL FROM slices ORDER BY name",
        };
        let mut st = self.conn.prepare_cached(sql).map_err(|e| err("slices_under", e))?;
        let map = |r: &rusqlite::Row<'_>| {
            Ok(SliceRow {
                name: r.get(0)?,
                seq: r.get::<_, i64>(1)? as u64,
                pos: r.get::<_, i64>(2)? as u64,
                live: r.get::<_, i64>(3)? != 0,
            })
        };
        let rows = match &bound {
            Some(b) => st.query_map(params![prefix, T(b)], map),
            None => st.query_map([], map),
        }
        .map_err(|e| err("slices_under", e))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| err("slices_under", e))
    }

    /// the slice's seq if it is live
    pub fn live_slice(&self, name: &str) -> Result<Option<u64>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT seq FROM slices WHERE name = ?1 AND death IS NULL")
            .map_err(|e| err("live_slice", e))?;
        st.query_row([name], |r| r.get::<_, i64>(0))
            .optional()
            .map(|s| s.map(|s| s as u64))
            .map_err(|e| err("live_slice", e))
    }

    /// a kv cursor, of which the store has one at a time
    pub fn cursor(&self, want_values: bool) -> Result<Cursor<'_>> {
        let seeks = self.seeks.try_borrow_mut().map_err(|_| "cursor: one is already open")?;
        Ok(Cursor { seeks, want_values, at: None })
    }
}

/// A prepared statement the store finalizes when it closes.
struct Stmt(NonNull<ffi::sqlite3_stmt>);

// a statement moves between threads with the connection that owns it, and is used by one at a time
unsafe impl Send for Stmt {}

impl Stmt {
    fn prepare(conn: &Connection, sql: &CStr) -> Result<Stmt> {
        let mut st = ptr::null_mut();
        unsafe {
            let db = conn.handle();
            let rc = ffi::sqlite3_prepare_v3(
                db,
                sql.as_ptr(),
                -1,
                ffi::SQLITE_PREPARE_PERSISTENT,
                &mut st,
                ptr::null_mut(),
            );
            match NonNull::new(st) {
                Some(st) if rc == ffi::SQLITE_OK => Ok(Stmt(st)),
                _ => Err(format!("cursor: {}", errmsg(db))),
            }
        }
    }
}

impl Drop for Stmt {
    fn drop(&mut self) {
        unsafe { ffi::sqlite3_finalize(self.0.as_ptr()) };
    }
}

unsafe fn errmsg(db: *mut ffi::sqlite3) -> String {
    unsafe { CStr::from_ptr(ffi::sqlite3_errmsg(db)) }.to_string_lossy().into_owned()
}

// the kv cursor's statements, one per direction and bound, each re-bound per seek
const FIRST: usize = 0;
const LAST: usize = 1;
const GE: usize = 2;
const GT: usize = 3;
const LE: usize = 4;
const LT: usize = 5;

struct Seeks([Stmt; 6]);

impl Seeks {
    fn prepare(conn: &Connection) -> Result<Seeks> {
        let p = |sql| Stmt::prepare(conn, sql);
        Ok(Seeks([
            p(c"SELECT key, value FROM kv ORDER BY key")?,
            p(c"SELECT key, value FROM kv ORDER BY key DESC")?,
            p(c"SELECT key, value FROM kv WHERE key >= ?1 ORDER BY key")?,
            p(c"SELECT key, value FROM kv WHERE key > ?1 ORDER BY key")?,
            p(c"SELECT key, value FROM kv WHERE key <= ?1 ORDER BY key DESC")?,
            p(c"SELECT key, value FROM kv WHERE key < ?1 ORDER BY key DESC")?,
        ]))
    }
}

/// the keys a walk steps through before it seeks: a SQLite seek costs about as much as 16 steps
pub const SCAN_STEP_BUDGET: usize = 16;

/// The kv cursor walks the kv table's keys, a scan's cursor.  The key and value at the cursor are
/// SQLite's own row, read in place.
pub struct Cursor<'s> {
    seeks: RefMut<'s, Seeks>,
    want_values: bool,
    // the statement positioned at the cursor's key, None past the end of the walk
    at: Option<usize>,
}

impl Cursor<'_> {
    fn stmt(&self, i: usize) -> *mut ffi::sqlite3_stmt {
        self.seeks.0[i].0.as_ptr()
    }

    // returns the statement the cursor is on to its start, which ends its read of the table
    fn end(&mut self) {
        if let Some(i) = self.at.take() {
            unsafe {
                ffi::sqlite3_reset(self.stmt(i));
                ffi::sqlite3_clear_bindings(self.stmt(i));
            }
        }
    }

    // steps the cursor's statement onto its next row, ending the walk past the last
    fn land(&mut self) -> Result<bool> {
        let Some(i) = self.at else { return Ok(false) };
        let st = self.stmt(i);
        let rc = unsafe { ffi::sqlite3_step(st) };
        if rc == ffi::SQLITE_ROW {
            return Ok(true);
        }
        let msg = (rc != ffi::SQLITE_DONE).then(|| unsafe { errmsg(ffi::sqlite3_db_handle(st)) });
        self.end();
        match msg {
            Some(m) => Err(format!("cursor: {m}")),
            None => Ok(false),
        }
    }

    // a column of the row at the cursor, as SQLite holds it
    fn column(&self, col: c_int) -> &[u8] {
        let Some(i) = self.at else { return &[] };
        let st = self.stmt(i);
        unsafe {
            let p = ffi::sqlite3_column_blob(st, col);
            let n = ffi::sqlite3_column_bytes(st, col);
            if p.is_null() { &[] } else { std::slice::from_raw_parts(p.cast(), n as usize) }
        }
    }
}

impl scan::Cursor for Cursor<'_> {
    fn seek(&mut self, reverse: bool, target: Option<&[u8]>, strict: bool) -> Result<bool> {
        self.end();
        let i = match (target, reverse, strict) {
            (None, false, _) => FIRST,
            (None, true, _) => LAST,
            (Some(_), false, false) => GE,
            (Some(_), false, true) => GT,
            (Some(_), true, false) => LE,
            (Some(_), true, true) => LT,
        };

        // the target is copied, since the caller may rewrite it while the statement runs
        if let Some(t) = target {
            let rc = unsafe {
                ffi::sqlite3_bind_text(
                    self.stmt(i),
                    1,
                    t.as_ptr().cast(),
                    t.len() as c_int,
                    ffi::SQLITE_TRANSIENT(),
                )
            };
            if rc != ffi::SQLITE_OK {
                let db = unsafe { ffi::sqlite3_db_handle(self.stmt(i)) };
                return Err(format!("cursor: {}", unsafe { errmsg(db) }));
            }
        }
        self.at = Some(i);
        self.land()
    }

    fn step(&mut self) -> Result<bool> {
        self.land()
    }

    fn key(&self) -> &[u8] {
        self.column(0)
    }

    fn value(&self) -> &[u8] {
        if self.want_values { self.column(1) } else { &[] }
    }
}

impl Drop for Cursor<'_> {
    fn drop(&mut self) {
        self.end();
    }
}
