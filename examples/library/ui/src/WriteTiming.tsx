import { useEffect, useState } from 'react';

// a duration as a reader takes it in: whole milliseconds, or tenths below ten
function ms(duration: number): string {
  return duration < 10 ? duration.toFixed(1) : String(Math.round(duration));
}

/** The last write's round trip, and how little of it the database took, from the Server-Timing
    the database answers each command request with.  The rest is the network's. */
export default function WriteTiming() {
  const [last, setLast] = useState<{ total: number; db: number } | null>(null);

  // each command request the page makes, the page's own room creation included
  useEffect(() => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (!new URL(entry.name).pathname.endsWith('/commands')) continue;
        const db = entry.serverTiming.find((t) => t.name === 'db');
        if (db !== undefined) setLast({ total: entry.duration, db: db.duration });
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    return () => observer.disconnect();
  }, []);

  if (last === null) return null;
  return (
    <p className="timing">
      Last write: {ms(last.total)} ms round trip, {ms(last.db)} ms of it in the database.
    </p>
  );
}
