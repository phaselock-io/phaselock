package main

// The cron scheduler, which ticks the bundle's cron entries.  It is pure Go over an injected
// fire and clock, so its tests run on a fake one; the server's fire hands each tick to the core,
// whose series table holds each entry's mark.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// cronCap is the longest the scheduler sleeps.  Its timers run on the monotonic clock, which
// stops while a machine is suspended or a VM is paused or restored, and slots are wall-clock
// times, which can also step; waking at least once a minute and recomputing from the wall clock
// keeps a tick at most a minute late after any of these.
const cronCap = time.Minute

// parseCron parses an entry's spec as robfig/cron's standard spec, in UTC unless it names a zone.
// An @every is rounded up to a whole minute, since slots are whole minutes, and notice says so.
func parseCron(spec string) (sched cron.Schedule, notice string, err error) {
	if !strings.HasPrefix(spec, "CRON_TZ=") && !strings.HasPrefix(spec, "TZ=") {
		spec = "CRON_TZ=UTC " + spec
	}
	sched, err = cron.ParseStandard(spec)
	if err != nil {
		return nil, "", err
	}
	if every, ok := sched.(cron.ConstantDelaySchedule); ok {
		d := (every.Delay + time.Minute - 1).Truncate(time.Minute)
		if d != every.Delay {
			notice = fmt.Sprintf("@every %v is rounded up to %v", every.Delay, d)
		}
		sched = cron.ConstantDelaySchedule{Delay: d}
	}
	return sched, notice, nil
}

// latestSlot is the last of sched's slots after mark and at or before now, if there is one.  An
// @every's slots are mark + k·d.
func latestSlot(sched cron.Schedule, mark, now time.Time) (time.Time, bool) {
	if every, ok := sched.(cron.ConstantDelaySchedule); ok {
		k := now.Sub(mark) / every.Delay
		return mark.Add(k * every.Delay), k > 0
	}
	var slot time.Time
	for t := sched.Next(mark); !t.IsZero() && !t.After(now); t = sched.Next(t) {
		slot = t
	}
	return slot, !slot.IsZero()
}

// cronScheduler fires the slots of every entry.  marks are the entries' marks, the last slot
// each fired, which it advances as it fires; now reads the wall clock.
type cronScheduler struct {
	scheds []cron.Schedule
	marks  []time.Time
	fire   func(i int, slot time.Time)
	now    func() time.Time
}

// run fires slots until ctx ends.  Each wake fires each entry's latest slot at or before now,
// and only that one, so a wake after downtime fires each entry once; the entry's mark becomes
// that slot, never the time it fired, so a late wake shifts no @every grid, and a clock stepped
// backwards finds nothing due until it passes the mark again.  Between wakes it sleeps until the
// earliest next slot, or for cronCap.
func (c *cronScheduler) run(ctx context.Context) {
	for {
		// fire what is due, and find the earliest slot to come
		now := c.now().Round(0)
		wake := now.Add(cronCap)
		for i, sched := range c.scheds {
			if slot, ok := latestSlot(sched, c.marks[i], now); ok {
				c.marks[i] = slot
				c.fire(i, slot)
			}
			if next := sched.Next(c.marks[i]); !next.IsZero() && next.Before(wake) {
				wake = next
			}
		}

		// sleep until then, from the time the firing finished
		timer := time.NewTimer(wake.Sub(c.now().Round(0)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
