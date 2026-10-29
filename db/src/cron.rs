//! The cron scheduler, which ticks the bundle's cron entries, and the standard cron specs it
//! reads: five fields (minute, hour, day of month, month, day of week) with ranges, steps, lists,
//! and names; the descriptors @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly,
//! and @every <duration>; and a leading CRON_TZ= or TZ= naming the zone, UTC otherwise.  A slot
//! is the time a schedule names, in Unix seconds.  An entry's mark, the last of its slots
//! decided, lives in the core's series table.

use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Datelike, LocalResult, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// The longest the scheduler sleeps.  Its timers run on the monotonic clock, which stops while a
/// machine is suspended or a VM is paused or restored, and slots are wall-clock times, which can
/// also step; waking at least once a minute and recomputing from the wall clock keeps a tick at
/// most a minute late after any of these.
const CRON_CAP: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub enum Schedule {
    /// @every: slots a fixed whole number of seconds apart, anchored at the mark
    Every(i64),
    Spec(Spec),
}

#[derive(Clone, Debug)]
pub struct Spec {
    minute: u64,
    hour: u64,
    dom: u64,
    month: u64,
    dow: u64,
    // whether day of month or day of week was a star, which makes the other alone decide
    dom_star: bool,
    dow_star: bool,
    tz: Tz,
}

const MONTHS: [&str; 12] =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// Parses a duration: a sequence of decimal numbers, each with an optional fraction and a unit,
/// such as "1m0s", "1.5h", or "300ms".
pub fn parse_duration(s: &str) -> Result<Duration, String> {
    let bad = || format!("time: invalid duration {s:?}");
    let mut rest = s;
    if rest == "0" {
        return Ok(Duration::ZERO);
    }
    if rest.is_empty() || rest.starts_with('-') {
        return Err(bad());
    }
    rest = rest.strip_prefix('+').unwrap_or(rest);
    let mut total = 0f64;
    while !rest.is_empty() {
        let n = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).ok_or_else(bad)?;
        let v: f64 = rest[..n].parse().map_err(|_| bad())?;
        rest = &rest[n..];
        let u = rest.find(|c: char| c.is_ascii_digit() || c == '.').unwrap_or(rest.len());
        let unit = match &rest[..u] {
            "ns" => 1e-9,
            "us" | "µs" | "μs" => 1e-6,
            "ms" => 1e-3,
            "s" => 1.0,
            "m" => 60.0,
            "h" => 3600.0,
            _ => return Err(bad()),
        };
        total += v * unit;
        rest = &rest[u..];
    }
    Ok(Duration::from_secs_f64(total))
}

fn field(s: &str, min: u32, max: u32, names: &[&str]) -> Result<(u64, bool), String> {
    let mut bits = 0u64;
    let mut star = false;
    let value = |v: &str| -> Result<u32, String> {
        if let Some(i) = names.iter().position(|n| n.eq_ignore_ascii_case(v)) {
            return Ok(i as u32 + min);
        }
        v.parse::<u32>().map_err(|_| format!("failed to parse int from {v}"))
    };
    for part in s.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, st)) => {
                (r, Some(st.parse::<u32>().map_err(|_| format!("failed to parse int from {st}"))?))
            }
            None => (part, None),
        };
        let (lo, hi) = if range == "*" || range == "?" {
            star = true;
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (value(a)?, value(b)?)
        } else {
            let v = value(range)?;
            (v, if step.is_some() { max } else { v })
        };
        if lo < min || hi > max || lo > hi {
            return Err(format!("end of range ({hi}) above maximum ({max}): {part}"));
        }
        let step = step.unwrap_or(1);
        if step == 0 {
            return Err(format!("step of range should be a positive number: {part}"));
        }
        if step > 1 {
            star = false;
        }
        let mut v = lo;
        while v <= hi {
            bits |= 1 << v;
            v += step;
        }
    }
    Ok((bits, star))
}

/// Parses an entry's spec, in UTC unless it names a zone.  An @every is rounded up to a whole
/// minute, since slots are whole minutes, and the notice says so.
pub fn parse(spec: &str) -> Result<(Schedule, Option<String>), String> {
    let mut s = spec.trim();
    let mut tz: Tz = chrono_tz::UTC;
    for prefix in ["CRON_TZ=", "TZ="] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let (name, rest) = rest.split_once(' ').ok_or("missing spec after the time zone")?;
            tz = name
                .parse()
                .map_err(|_| format!("provided bad location {name}: unknown time zone {name}"))?;
            s = rest.trim();
        }
    }
    if let Some(d) = s.strip_prefix("@every ") {
        let d =
            parse_duration(d.trim()).map_err(|e| format!("failed to parse duration {s}: {e}"))?;
        let secs = d.as_secs_f64().ceil().max(1.0) as i64;
        let minutes = (secs + 59) / 60 * 60;
        let notice = (Duration::from_secs(minutes as u64) != d).then(|| {
            format!(
                "@every {} is rounded up to {}",
                go_duration(d),
                go_duration(Duration::from_secs(minutes as u64))
            )
        });
        return Ok((Schedule::Every(minutes), notice));
    }
    let fields: Vec<&str> = match s {
        "@yearly" | "@annually" => vec!["0", "0", "1", "1", "*"],
        "@monthly" => vec!["0", "0", "1", "*", "*"],
        "@weekly" => vec!["0", "0", "*", "*", "0"],
        "@daily" | "@midnight" => vec!["0", "0", "*", "*", "*"],
        "@hourly" => vec!["0", "*", "*", "*", "*"],
        _ if s.starts_with('@') => return Err(format!("unrecognized descriptor: {s}")),
        _ => s.split_whitespace().collect(),
    };
    if fields.len() != 5 {
        return Err(format!("expected exactly 5 fields, found {}: {s}", fields.len()));
    }
    let (minute, _) = field(fields[0], 0, 59, &[])?;
    let (hour, _) = field(fields[1], 0, 23, &[])?;
    let (dom, dom_star) = field(fields[2], 1, 31, &[])?;
    let (month, _) = field(fields[3], 1, 12, &MONTHS)?;
    let (mut dow, dow_star) = field(fields[4], 0, 7, &DAYS)?;
    if dow & (1 << 7) != 0 {
        dow |= 1;
    }
    Ok((Schedule::Spec(Spec { minute, hour, dom, month, dow, dom_star, dow_star, tz }), None))
}

/// a duration as hours, minutes, and seconds, such as "1m0s" or "1h30m0s"
fn go_duration(d: Duration) -> String {
    let s = d.as_secs();
    let ns = d.subsec_nanos();
    if s == 0 && ns == 0 {
        return "0s".into();
    }
    let (h, m, sec) = (s / 3600, s / 60 % 60, s % 60);
    let secs =
        if ns == 0 { format!("{sec}s") } else { format!("{}s", sec as f64 + ns as f64 / 1e9) };
    match (h, m) {
        (0, 0) => secs,
        (0, m) => format!("{m}m{secs}"),
        (h, m) => format!("{h}h{m}m{secs}"),
    }
}

impl Spec {
    fn day_matches(&self, t: &DateTime<Tz>) -> bool {
        let dom = self.dom & (1 << t.day()) != 0;
        let dow = self.dow & (1 << t.weekday().num_days_from_sunday()) != 0;
        if self.dom_star || self.dow_star { dom && dow } else { dom || dow }
    }

    // the local time, the earlier of two when a clock fell back, and past a gap a clock jumped
    fn local(&self, d: NaiveDate, h: u32, m: u32) -> DateTime<Tz> {
        let naive = d.and_hms_opt(h, m, 0).unwrap();
        match self.tz.from_local_datetime(&naive) {
            LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
            LocalResult::None => {
                let later = naive + chrono::Duration::hours(1);
                self.tz
                    .from_local_datetime(&later)
                    .earliest()
                    .unwrap_or_else(|| self.tz.from_utc_datetime(&naive))
            }
        }
    }

    /// the first slot after the time after, in Unix seconds
    fn next(&self, after: i64) -> Option<i64> {
        // a slot is a whole minute, so the search starts at the first one after after
        let start = (after + 1 + 59).div_euclid(60) * 60;
        let mut t = self.tz.timestamp_opt(start, 0).single()?;
        let year_limit = t.year() + 5;
        let mut added = false;
        'wrap: loop {
            if t.year() > year_limit {
                return None;
            }
            while self.month & (1 << t.month()) == 0 {
                if !added {
                    added = true;
                    t = self.local(NaiveDate::from_ymd_opt(t.year(), t.month(), 1)?, 0, 0);
                }
                let (y, mo) =
                    if t.month() == 12 { (t.year() + 1, 1) } else { (t.year(), t.month() + 1) };
                t = self.local(NaiveDate::from_ymd_opt(y, mo, 1)?, 0, 0);
                if t.month() == 1 {
                    continue 'wrap;
                }
            }
            while !self.day_matches(&t) {
                if !added {
                    added = true;
                    t = self.local(t.date_naive(), 0, 0);
                }
                t = self.local(t.date_naive().succ_opt()?, 0, 0);
                if t.day() == 1 {
                    continue 'wrap;
                }
            }
            while self.hour & (1 << t.hour()) == 0 {
                if !added {
                    added = true;
                    t = self.local(t.date_naive(), t.hour(), 0);
                }
                t += chrono::Duration::hours(1);
                if t.hour() == 0 {
                    continue 'wrap;
                }
            }
            while self.minute & (1 << t.minute()) == 0 {
                added = true;
                t += chrono::Duration::minutes(1);
                if t.minute() == 0 {
                    continue 'wrap;
                }
            }
            return Some(t.timestamp());
        }
    }
}

impl Schedule {
    pub fn next(&self, after: i64) -> Option<i64> {
        match self {
            Schedule::Every(d) => Some(after + d),
            Schedule::Spec(s) => s.next(after),
        }
    }

    /// the last of the schedule's slots after mark and at or before now, if there is one; an
    /// @every's slots are mark + k·d
    pub fn latest(&self, mark: i64, now: i64) -> Option<i64> {
        match self {
            Schedule::Every(d) => {
                let k = (now - mark).div_euclid(*d);
                (k > 0).then_some(mark + k * d)
            }
            Schedule::Spec(_) => {
                let mut slot = None;
                let mut t = self.next(mark);
                while let Some(s) = t.filter(|&s| s <= now) {
                    slot = Some(s);
                    t = self.next(s);
                }
                slot
            }
        }
    }
}

/// a slot as RFC 3339, for the log
pub fn rfc3339(slot: i64) -> String {
    Utc.timestamp_opt(slot, 0).single().map(|t| t.to_rfc3339()).unwrap_or_default()
}

/// Fires the slots of every entry.  marks are the entries' marks, the last slot each fired,
/// which it advances as it fires; the wall clock it reads is given to run, in Unix milliseconds.
pub struct Scheduler {
    pub scheds: Vec<Schedule>,
    pub marks: Vec<i64>,
}

impl Scheduler {
    /* Fires slots for as long as it runs.  Each wake fires each entry's latest slot at or before
    now, and only that one, so a wake after downtime fires each entry once; the entry's mark
    becomes that slot, never the time it fired, so a late wake shifts no @every grid, and a
    clock stepped backwards finds nothing due until it passes the mark again.  Between wakes it
    sleeps until the earliest next slot, or for CRON_CAP. */
    pub async fn run<C, F, Fut>(mut self, clock: C, fire: F)
    where
        C: Fn() -> i64,
        F: Fn(usize, i64) -> Fut,
        Fut: Future<Output = ()>,
    {
        loop {
            // fire what is due, and find the earliest slot to come
            let now = clock().div_euclid(1000);
            let mut wake = now + CRON_CAP.as_secs() as i64;
            for i in 0..self.scheds.len() {
                if let Some(slot) = self.scheds[i].latest(self.marks[i], now) {
                    self.marks[i] = slot;
                    fire(i, slot).await;
                }
                if let Some(next) = self.scheds[i].next(self.marks[i]) {
                    wake = wake.min(next);
                }
            }

            // sleep until then, from the time the firing finished
            let left = wake * 1000 - clock();
            tokio::time::sleep(Duration::from_millis(left.max(0) as u64)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    // a time on the first day, 2000-01-01 in UTC, in Unix seconds
    fn at(h: i64, m: i64) -> i64 {
        Utc.with_ymd_and_hms(2000, 1, 1, 0, 0, 0).unwrap().timestamp() + h * 3600 + m * 60
    }

    // (entry, slot, the time it fired), slot and time in Unix seconds
    type Fires = Arc<Mutex<Vec<(usize, i64, i64)>>>;

    /* Runs a scheduler over specs from marks on tokio's paused clock, which starts at 00:00 of the
    first day and is offset by the given milliseconds, recording each fire; a fire of the slot
    slow sleeps for three minutes. */
    fn schedule(
        specs: &[&str],
        marks: &[i64],
        offset: Arc<AtomicI64>,
        slow: Option<i64>,
    ) -> (Fires, tokio::task::JoinHandle<()>) {
        let scheds = specs.iter().map(|s| parse(s).unwrap().0).collect();
        let s = Scheduler { scheds, marks: marks.to_vec() };
        let start = tokio::time::Instant::now();
        let clock = move || {
            at(0, 0) * 1000 + start.elapsed().as_millis() as i64 + offset.load(Ordering::SeqCst)
        };
        let fires: Fires = Arc::default();
        let f = fires.clone();
        let c = clock.clone();
        let task = tokio::spawn(s.run(clock, move |i, slot| {
            f.lock().unwrap().push((i, slot, c() / 1000));
            async move {
                if Some(slot) == slow {
                    tokio::time::sleep(Duration::from_secs(180)).await;
                }
            }
        }));
        (fires, task)
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fires_each_slot_when_it_arrives() {
        let (fires, task) = schedule(&["*/5 * * * *"], &[at(0, 0)], Arc::default(), None);
        tokio::time::sleep(Duration::from_secs(31 * 60)).await;
        task.abort();
        let fires = fires.lock().unwrap().clone();
        assert_eq!(fires.len(), 6, "six slots in half an hour: {fires:?}");
        for (k, &(_, slot, fired)) in fires.iter().enumerate() {
            let want = at(0, 5 * (k as i64 + 1));
            assert!(slot == want && fired == want, "fire {k}: slot {slot} at {fired}, want {want}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fires_only_the_latest_missed_slot() {
        // three hourly slots passed during downtime, and only the last fires, at once
        let (fires, task) = schedule(&["0 * * * *"], &[at(0, 0) - 3 * 3600], Arc::default(), None);
        tokio::time::sleep(Duration::from_secs(61 * 60)).await;
        task.abort();
        let f = fires.lock().unwrap().clone();
        assert!(
            f.len() == 2 && f[0].1 == at(0, 0) && f[0].2 == at(0, 0) && f[1].1 == at(1, 0),
            "{f:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn every_is_anchored_to_its_mark() {
        // the first fire takes three minutes, which shifts nothing after it
        let (fires, task) =
            schedule(&["@every 7m"], &[at(0, 0) - 180], Arc::default(), Some(at(0, 4)));
        tokio::time::sleep(Duration::from_secs(19 * 60)).await;
        task.abort();
        let f = fires.lock().unwrap().clone();
        assert_eq!(f.len(), 3, "three slots: {f:?}");
        for (k, &(_, slot, fired)) in f.iter().enumerate() {
            let want = at(0, 4 + 7 * k as i64);
            assert!(slot == want && fired == want, "fire {k}: slot {slot} at {fired}, want {want}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn recomputes_after_the_clock_steps() {
        let offset = Arc::new(AtomicI64::new(0));
        let (fires, task) = schedule(&["0 6 * * *"], &[at(0, 0)], offset.clone(), None);

        // a step forward a day, at 00:10, fires the slot it passed within a minute
        tokio::time::sleep(Duration::from_secs(600)).await;
        offset.store(24 * 3600 * 1000, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(60)).await;
        settle().await;
        let f = fires.lock().unwrap().clone();
        assert!(f.len() == 1 && f[0].1 == at(6, 0), "the passed slot, once: {f:?}");

        // a step back fires nothing again, until the wall clock reaches the next slot
        offset.store(0, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(30 * 3600)).await;
        task.abort();
        let f = fires.lock().unwrap().clone();
        let next = at(6, 0) + 24 * 3600;
        assert!(
            f.len() == 2 && f[1].1 == next && f[1].2 == next,
            "no refire, then the next day's slot on time: {f:?}"
        );
    }

    #[test]
    fn specs_are_in_utc_unless_zoned() {
        assert_eq!(parse("0 6 * * *").unwrap().0.next(at(0, 0)), Some(at(6, 0)));
        assert_eq!(
            parse("CRON_TZ=America/New_York 0 6 * * *").unwrap().0.next(at(0, 0)),
            Some(at(11, 0))
        );
    }

    #[test]
    fn across_daylight_saving_changes() {
        let ny: Tz = "America/New_York".parse().unwrap();
        let slots = |spec: &str, from: i64, n: usize| {
            let (s, _) = parse(spec).unwrap();
            let mut out = Vec::new();
            let mut t = from;
            while out.len() < n {
                t = s.next(t).unwrap();
                out.push(ny.timestamp_opt(t, 0).unwrap());
            }
            out
        };
        let day = |y, m, d| ny.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp();

        // 02:30 does not exist on the day clocks spring forward, so that day has no slot
        let spring = slots("CRON_TZ=America/New_York 30 2 * * *", day(2026, 3, 7), 2);
        assert!(spring[0].day() == 7 && spring[1].day() == 9, "the skipped day: {spring:?}");

        // 01:30 happens twice on the day clocks fall back, so that day has two slots
        let fall = slots("CRON_TZ=America/New_York 30 1 * * *", day(2026, 11, 1), 3);
        assert!(
            fall[0].day() == 1
                && fall[1].day() == 1
                && fall[1].timestamp() - fall[0].timestamp() == 3600
                && fall[2].day() == 2,
            "the repeated hour: {fall:?}"
        );
    }

    #[test]
    fn rounds_every_up_to_a_whole_minute() {
        for (spec, every, rounded) in [
            ("@every 90s", 120, true),
            ("@every 10s", 60, true),
            ("@every 1h", 3600, false),
            ("CRON_TZ=UTC @every 5m", 300, false),
        ] {
            let (s, notice) = parse(spec).unwrap();
            assert!(
                matches!(s, Schedule::Every(d) if d == every) && notice.is_some() == rounded,
                "{spec}"
            );
        }
        assert_eq!(parse("@every 90s").unwrap().1.unwrap(), "@every 1m30s is rounded up to 2m0s");
    }

    #[test]
    fn refuses_malformed_specs() {
        for spec in ["61 * * * *", "* * * *", "@sometimes", "CRON_TZ=Nowhere/Else 0 6 * * *"] {
            assert!(parse(spec).is_err(), "{spec} parsed");
        }
    }

    #[test]
    fn latest_slot() {
        let (every, _) = parse("@every 7m").unwrap();
        assert_eq!(every.latest(at(0, 0), at(0, 20)), Some(at(0, 14)));
        assert_eq!(every.latest(at(0, 0), at(0, 6)), None);
        assert_eq!(every.latest(at(0, 10), at(0, 0)), None);
        let (daily, _) = parse("0 6 * * *").unwrap();
        assert_eq!(daily.latest(at(0, 0), at(0, 0) + 50 * 3600), Some(at(6, 0) + 24 * 3600));
    }
}
