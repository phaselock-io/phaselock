//! The reader thread: its own SQLite connection, serving history reads, edit reads, snapshot
//! cuts, and the token keys, one job at a time, each cut in its own read transaction.

use std::sync::Mutex;
use std::sync::mpsc;

use bytes::Bytes;
use phaselock_core::mp;
use phaselock_core::names::is_prefix_selector;
use tokio::sync::oneshot;

use super::Item;
use crate::store::{LogRow, Store, TokenKeyRow};

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Job {
    ReadLog {
        from: u64,
        to: u64,
        reply: Reply<Vec<Item>>,
    },
    ReadEdits {
        selector: String,
        from: u64,
        to: u64,
        reverse: bool,
        limit: usize,
        reply: Reply<Vec<Item>>,
    },
    Head {
        reply: Reply<u64>,
    },
    Snapshot {
        selector: String,
        reply: Reply<(Vec<u8>, u64)>,
    },
    Keys {
        reply: Reply<Vec<TokenKeyRow>>,
    },
}

pub struct Reader {
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

fn item(r: LogRow) -> Item {
    Item { slice: r.slice, position: r.position, data: Bytes::from(r.edit) }
}

impl Reader {
    pub fn open(path: &str, cache_mib: i64, epoch: String) -> Result<Reader, String> {
        let store = Store::open(path, false, cache_mib)?;
        let (tx, rx) = mpsc::channel::<Job>();
        let thread = std::thread::Builder::new()
            .name("pldb-reader".into())
            .spawn(move || {
                for job in rx {
                    serve(&store, &epoch, job);
                }
            })
            .map_err(|e| format!("spawning the reader: {e}"))?;
        Ok(Reader { jobs: Mutex::new(Some(tx)), thread: Mutex::new(Some(thread)) })
    }

    async fn ask<T>(&self, make: impl FnOnce(Reply<T>) -> Job) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        {
            let jobs = self.jobs.lock().unwrap();
            let Some(jobs) = jobs.as_ref() else { return Err("the reader is closed".into()) };
            jobs.send(make(tx)).map_err(|_| "the reader is closed".to_string())?;
        }
        rx.await.map_err(|_| "the reader is closed".to_string())?
    }

    /// the log's edits with from <= position <= to
    pub async fn read_log(&self, from: u64, to: u64) -> Result<Vec<Item>, String> {
        if from > to {
            return Ok(Vec::new());
        }
        self.ask(|reply| Job::ReadLog { from, to, reply }).await
    }

    /// A selector's edits with from < position < to, ascending or descending: limit of them and
    /// the rest of the last one's position, since a read never splits the edits of one mutation,
    /// or fewer when the range runs out.
    pub async fn read_edits(
        &self,
        selector: &str,
        from: u64,
        to: u64,
        reverse: bool,
        limit: usize,
    ) -> Result<Vec<Item>, String> {
        if from + 1 >= to {
            return Ok(Vec::new());
        }
        let selector = selector.to_string();
        self.ask(|reply| Job::ReadEdits { selector, from, to, reverse, limit, reply }).await
    }

    /// the log's last position
    pub async fn head(&self) -> Result<u64, String> {
        self.ask(|reply| Job::Head { reply }).await
    }

    /// a snapshot blob of the selector and the position it was cut at
    pub async fn snapshot(&self, selector: &str) -> Result<(Vec<u8>, u64), String> {
        let selector = selector.to_string();
        self.ask(|reply| Job::Snapshot { selector, reply }).await
    }

    /// every stored token key, oldest first
    pub async fn keys(&self) -> Result<Vec<TokenKeyRow>, String> {
        self.ask(|reply| Job::Keys { reply }).await
    }

    pub fn close(&self) {
        self.jobs.lock().unwrap().take();
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
    }
}

fn serve(st: &Store, epoch: &str, job: Job) {
    match job {
        Job::ReadLog { from, to, reply } => {
            let mut out = Vec::new();
            let r = st.read_log(from, to, |row| {
                out.push(item(row));
                true
            });
            let _ = reply.send(r.map(|()| out));
        }
        Job::ReadEdits { selector, from, to, reverse, limit, reply } => {
            let _ = reply.send(read_edits(st, &selector, from, to, reverse, limit));
        }
        Job::Head { reply } => {
            let _ = reply.send(st.max_position());
        }
        Job::Snapshot { selector, reply } => {
            let _ = reply.send(snapshot(st, epoch, &selector));
        }
        Job::Keys { reply } => {
            let _ = reply.send(st.keys());
        }
    }
}

fn read_edits(
    st: &Store,
    selector: &str,
    from: u64,
    to: u64,
    reverse: bool,
    limit: usize,
) -> Result<Vec<Item>, String> {
    // limit of them, past which the read goes on only to the end of the last edit's position
    let limit = limit.max(1);
    let mut out: Vec<Item> = Vec::new();
    let take = |row: LogRow, out: &mut Vec<Item>| {
        if out.len() >= limit && out.last().is_some_and(|l| l.position != row.position) {
            return false;
        }
        out.push(item(row));
        true
    };
    if is_prefix_selector(selector) {
        st.read_prefix(&selector[..selector.len() - 1], from, to, reverse, |r| take(r, &mut out))?;
    } else {
        st.read_slice(selector, from, to, reverse, |r| take(r, &mut out))?;
    }

    // a reverse read's edits of one position, which came in descending slice order, ascending
    if reverse {
        let mut i = 0;
        while i < out.len() {
            let mut j = i;
            while j < out.len() && out[j].position == out[i].position {
                j += 1;
            }
            out[i..j].reverse();
            i = j;
        }
    }
    Ok(out)
}

fn crc32c(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0x82F6_3B78 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xFFFF_FFFF
}

fn fnv1a(data: &[u8]) -> u64 {
    data.iter().fold(14695981039346656037u64, |h, &b| (h ^ b as u64).wrapping_mul(1099511628211))
}

/// A snapshot blob of the selector, its keys and header cut in one read transaction, so every
/// slice is at the position.  See the snapshot blob's layout in the database's README.
fn snapshot(st: &Store, epoch: &str, selector: &str) -> Result<(Vec<u8>, u64), String> {
    let prefix = if is_prefix_selector(selector) {
        selector[..selector.len() - 1].to_string()
    } else {
        format!("{selector}!")
    };

    // the keys and the header, in one read transaction
    st.exec("BEGIN")?;
    let cut = (|| {
        let position = st.max_position()?;

        // the body: each key and its value as one set operation, 0, key, value, the value inline
        // as stored
        let mut body = mp::Writer::new();
        let mut count = 0u32;
        st.scan(prefix.as_bytes(), |k, v| {
            body.uint(0);
            body.str(k);
            body.raw(v);
            count += 1;
        })?;

        // the header's slices map, and the last position any slice under the selector changed,
        // dead ones included
        let mut slices = mp::Writer::new();
        let mut nslices = 0;
        let mut visible = 0;
        let mut stats = None;
        if is_prefix_selector(selector) {
            for row in st.slices_under(&prefix)? {
                visible = visible.max(row.pos);
                if row.live {
                    slices.str(row.name.as_bytes());
                    slices.uint(row.seq);
                    nslices += 1;
                }
            }
        } else {
            // an exact slice's last edit counts whether or not it is live
            stats = st.slice_stats(selector)?;
            let live = st.live_slice(selector)?;
            if let Some(s) = &stats {
                visible = s.pos;
                if let Some(seq) = live {
                    slices.str(selector.as_bytes());
                    slices.uint(seq);
                    nslices += 1;
                }
            }
        }

        let mut h = mp::Writer::new();
        h.map(if stats.is_some() { 7 } else { 5 });
        h.str(b"selector");
        h.str(selector.as_bytes());
        h.str(b"position");
        h.uint(position);
        h.str(b"epoch");
        h.str(epoch.as_bytes());
        h.str(b"slices");
        h.map(nslices);
        h.raw(&slices.buf);
        h.str(b"visible");
        h.uint(visible);
        if let Some(s) = &stats {
            h.str(b"edit_bytes");
            h.uint(s.edit_bytes);
            h.str(b"state_bytes");
            h.uint(s.state_bytes);
        }
        Ok::<_, String>((h.into_vec(), body.into_vec(), count, position))
    })();
    let _ = st.exec("COMMIT");
    let (header, body, count, position) = cut?;

    // magic, version, the header and its crc, the operations, the end marker, and the footer
    let mut b = Vec::with_capacity(header.len() + body.len() + 40);
    b.extend_from_slice(b"PLSN");
    b.push(1);
    b.extend_from_slice(&(header.len() as u32).to_be_bytes());
    b.extend_from_slice(&header);
    b.extend_from_slice(&crc32c(&header).to_be_bytes());
    b.extend_from_slice(&body);
    b.extend_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
    let mut footer = Vec::with_capacity(12);
    footer.extend_from_slice(&count.to_be_bytes());
    footer.extend_from_slice(&fnv1a(&body).to_be_bytes());
    b.extend_from_slice(&footer);
    b.extend_from_slice(&crc32c(&footer).to_be_bytes());
    Ok((b, position))
}
