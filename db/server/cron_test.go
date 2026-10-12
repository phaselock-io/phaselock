package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/robfig/cron/v3"
)

// firing is one fire of a scheduler under test: the entry, its slot, and the fake time it fired.
type firing struct {
	entry    int
	slot, at time.Time
}

// scheduling is a scheduler running in a synctest bubble, recording its fires.
type scheduling struct {
	mu    sync.Mutex
	fires []firing
	stop  context.CancelFunc
	done  chan struct{}
}

// schedule runs a scheduler over specs from marks, its wall clock now, or the bubble's clock for
// nil, its fire recording and then calling during, if any.
func schedule(t *testing.T, specs []string, marks []time.Time, now func() time.Time,
	during func(i int, slot time.Time)) *scheduling {
	t.Helper()
	scheds := make([]cron.Schedule, len(specs))
	for i, spec := range specs {
		sched, _, err := parseCron(spec)
		if err != nil {
			t.Fatalf("parse %q: %v", spec, err)
		}
		scheds[i] = sched
	}
	if now == nil {
		now = time.Now
	}
	s := &scheduling{done: make(chan struct{})}
	fire := func(i int, slot time.Time) {
		s.mu.Lock()
		s.fires = append(s.fires, firing{i, slot, time.Now()})
		s.mu.Unlock()
		if during != nil {
			during(i, slot)
		}
	}
	ctx, stop := context.WithCancel(context.Background())
	s.stop = stop
	sc := &cronScheduler{scheds: scheds, marks: append([]time.Time(nil), marks...), fire: fire, now: now}
	go func() {
		defer close(s.done)
		sc.run(ctx)
	}()
	return s
}

// end stops the scheduler and answers what it fired.
func (s *scheduling) end() []firing {
	s.stop()
	<-s.done
	return s.fires
}

// at is a time on the bubble's first day, 2000-01-01 in UTC.
func at(h, m int) time.Time { return time.Date(2000, 1, 1, h, m, 0, 0, time.UTC) }

func TestCronFiresEachSlotWhenItArrives(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := schedule(t, []string{"*/5 * * * *"}, []time.Time{at(0, 0)}, nil, nil)
		time.Sleep(31 * time.Minute)
		fires := s.end()
		if len(fires) != 6 {
			t.Fatalf("six slots in half an hour: %+v", fires)
		}
		for k, f := range fires {
			if want := at(0, 5*(k+1)); !f.slot.Equal(want) || !f.at.Equal(want) {
				t.Fatalf("fire %d: slot %v at %v, want both %v", k, f.slot, f.at, want)
			}
		}
	})
}

func TestCronFiresOnlyTheLatestMissedSlot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// three hourly slots passed during downtime, and only the last fires, at once
		s := schedule(t, []string{"0 * * * *"}, []time.Time{at(0, 0).Add(-3 * time.Hour)}, nil, nil)
		time.Sleep(61 * time.Minute)
		fires := s.end()
		if len(fires) != 2 || !fires[0].slot.Equal(at(0, 0)) || !fires[0].at.Equal(at(0, 0)) ||
			!fires[1].slot.Equal(at(1, 0)) {
			t.Fatalf("the latest missed slot, then the next: %+v", fires)
		}
	})
}

func TestCronEveryIsAnchoredToItsMark(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// the first fire takes three minutes, which shifts nothing after it
		slow := func(i int, slot time.Time) {
			if slot.Equal(at(0, 4)) {
				time.Sleep(3 * time.Minute)
			}
		}
		s := schedule(t, []string{"@every 7m"}, []time.Time{at(0, 0).Add(-3 * time.Minute)}, nil, slow)
		time.Sleep(19 * time.Minute)
		fires := s.end()
		if len(fires) != 3 {
			t.Fatalf("three slots: %+v", fires)
		}
		for k, f := range fires {
			if want := at(0, 4+7*k); !f.slot.Equal(want) || !f.at.Equal(want) {
				t.Fatalf("fire %d: slot %v at %v, want both %v", k, f.slot, f.at, want)
			}
		}
	})
}

func TestCronRecomputesAfterTheClockSteps(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var offset atomic.Int64
		wall := func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
		s := schedule(t, []string{"0 6 * * *"}, []time.Time{at(0, 0)}, wall, nil)

		// a step forward a day, at 00:10, fires the slot it passed within a minute
		time.Sleep(10 * time.Minute)
		offset.Store(int64(24 * time.Hour))
		time.Sleep(time.Minute)
		synctest.Wait()
		s.mu.Lock()
		fires := append([]firing(nil), s.fires...)
		s.mu.Unlock()
		if len(fires) != 1 || !fires[0].slot.Equal(at(6, 0)) {
			t.Fatalf("the passed slot, once: %+v", fires)
		}

		// a step back fires nothing again, until the wall clock reaches the next slot
		offset.Store(0)
		time.Sleep(30 * time.Hour)
		fires = s.end()
		if len(fires) != 2 || !fires[1].slot.Equal(at(6, 0).Add(24*time.Hour)) ||
			!fires[1].at.Equal(at(6, 0).Add(24*time.Hour)) {
			t.Fatalf("no refire, then the next day's slot on time: %+v", fires)
		}
	})
}

func TestCronSpecsAreInUTCUnlessZoned(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	local := time.Local
	time.Local = ny
	defer func() { time.Local = local }()

	utc, _, _ := parseCron("0 6 * * *")
	if got := utc.Next(at(0, 0)); !got.Equal(at(6, 0)) {
		t.Fatalf("a spec without a zone, in a server zoned elsewhere: %v", got)
	}
	zoned, _, _ := parseCron("CRON_TZ=America/New_York 0 6 * * *")
	if got := zoned.Next(at(0, 0)); !got.Equal(at(11, 0)) {
		t.Fatalf("a zoned spec: %v", got)
	}
}

func TestCronAcrossDaylightSavingChanges(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	slots := func(spec string, from time.Time, n int) []time.Time {
		sched, _, err := parseCron(spec)
		if err != nil {
			t.Fatal(err)
		}
		var out []time.Time
		for t := from; len(out) < n; {
			t = sched.Next(t)
			out = append(out, t)
		}
		return out
	}

	// 02:30 does not exist on the day clocks spring forward, so that day has no slot
	spring := slots("CRON_TZ=America/New_York 30 2 * * *", time.Date(2026, 3, 7, 0, 0, 0, 0, ny), 2)
	if spring[0].Day() != 7 || spring[1].In(ny).Day() != 9 {
		t.Fatalf("the skipped day: %v", spring)
	}

	// 01:30 happens twice on the day clocks fall back, so that day has two slots
	fall := slots("CRON_TZ=America/New_York 30 1 * * *", time.Date(2026, 11, 1, 0, 0, 0, 0, ny), 3)
	if fall[0].In(ny).Day() != 1 || fall[1].In(ny).Day() != 1 || fall[1].Sub(fall[0]) != time.Hour ||
		fall[2].In(ny).Day() != 2 {
		t.Fatalf("the repeated hour: %v", fall)
	}
}

func TestCronRoundsEveryUpToAWholeMinute(t *testing.T) {
	for _, c := range []struct {
		spec    string
		every   time.Duration
		rounded bool
	}{
		{"@every 90s", 2 * time.Minute, true},
		{"@every 10s", time.Minute, true},
		{"@every 1h", time.Hour, false},
		{"CRON_TZ=UTC @every 5m", 5 * time.Minute, false},
	} {
		sched, notice, err := parseCron(c.spec)
		if err != nil {
			t.Fatalf("%s: %v", c.spec, err)
		}
		if got := sched.(cron.ConstantDelaySchedule).Delay; got != c.every || (notice != "") != c.rounded {
			t.Fatalf("%s: every %v with notice %q", c.spec, got, notice)
		}
	}
}

func TestCronRefusesMalformedSpecs(t *testing.T) {
	for _, spec := range []string{"61 * * * *", "* * * *", "@sometimes", "CRON_TZ=Nowhere/Else 0 6 * * *"} {
		if _, _, err := parseCron(spec); err == nil {
			t.Fatalf("%q parsed", spec)
		}
	}
}

func TestCronLatestSlot(t *testing.T) {
	every, _, _ := parseCron("@every 7m")
	if slot, ok := latestSlot(every, at(0, 0), at(0, 20)); !ok || !slot.Equal(at(0, 14)) {
		t.Fatalf("an @every's latest slot: %v %v", slot, ok)
	}
	if _, ok := latestSlot(every, at(0, 0), at(0, 6)); ok {
		t.Fatal("an @every slot before its first")
	}
	if _, ok := latestSlot(every, at(0, 10), at(0, 0)); ok {
		t.Fatal("an @every slot before its mark")
	}
	daily, _, _ := parseCron("0 6 * * *")
	if slot, ok := latestSlot(daily, at(0, 0), at(0, 0).Add(50*time.Hour)); !ok ||
		!slot.Equal(at(6, 0).Add(24*time.Hour)) {
		t.Fatalf("a calendar spec's latest slot: %v %v", slot, ok)
	}
}
