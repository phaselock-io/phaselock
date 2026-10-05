package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// a job that holds its worker until released, reporting when it starts
func holding() (run func(), started, release chan struct{}) {
	started = make(chan struct{})
	release = make(chan struct{})
	run = func() {
		close(started)
		<-release
	}
	return run, started, release
}

func TestHashPoolBoundsItsQueue(t *testing.T) {
	p := newHashPool(t.Context(), 1, 1)
	run, started, release := holding()

	// the worker takes the first job and the queue holds the second; the third is refused
	first := make(chan error, 1)
	go func() { first <- p.do(t.Context(), run) }()
	<-started
	second := make(chan error, 1)
	go func() { second <- p.do(t.Context(), func() {}) }()
	time.Sleep(20 * time.Millisecond)
	if err := p.do(t.Context(), func() {}); !errors.Is(err, errBusy) {
		t.Fatalf("a full queue: %v, want errBusy", err)
	}

	// once the worker is free both queued jobs finish
	close(release)
	if err := <-first; err != nil {
		t.Fatalf("first job: %v", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("second job: %v", err)
	}
}

func TestHashPoolSkipsTheJobsOfClientsThatLeft(t *testing.T) {
	p := newHashPool(t.Context(), 1, 4)
	run, started, release := holding()
	go p.do(t.Context(), run)
	<-started

	// a job queued behind the busy worker whose client then leaves
	var ran atomic.Bool
	gone, leave := context.WithCancel(t.Context())
	waited := make(chan error, 1)
	go func() { waited <- p.do(gone, func() { ran.Store(true) }) }()
	time.Sleep(20 * time.Millisecond)
	leave()

	// the client stops waiting at once, and the worker skips its job
	if err := <-waited; !errors.Is(err, context.Canceled) {
		t.Fatalf("the waiting client: %v, want context.Canceled", err)
	}
	close(release)
	if err := p.do(t.Context(), func() {}); err != nil {
		t.Fatalf("a later job: %v", err)
	}
	if ran.Load() {
		t.Fatalf("the job of a client that left was run")
	}
}

func TestHashPoolStopsWithItsContext(t *testing.T) {
	ctx, stop := context.WithCancel(t.Context())
	p := newHashPool(ctx, 1, 4)
	run, started, release := holding()
	running := make(chan error, 1)
	go func() { running <- p.do(t.Context(), run) }()
	<-started

	// a queued job, and then shutdown
	var ran atomic.Bool
	queued := make(chan error, 1)
	go func() { queued <- p.do(t.Context(), func() { ran.Store(true) }) }()
	time.Sleep(20 * time.Millisecond)
	stop()

	// the queued job's client is answered at once, and its job never runs
	if err := <-queued; !errors.Is(err, errClosed) {
		t.Fatalf("the queued client: %v, want errClosed", err)
	}

	// the hash in progress finishes, and then the workers are gone
	close(release)
	<-running
	p.wait()
	if ran.Load() {
		t.Fatalf("a queued job ran after shutdown")
	}
	if err := p.do(t.Context(), func() {}); !errors.Is(err, errClosed) {
		t.Fatalf("a job after shutdown: %v, want errClosed", err)
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	l := newLimiter(2, 3)
	l.now = func() time.Time { return now }

	// a burst, then refusal
	for i := 0; i < 3; i++ {
		if !l.allow("a") {
			t.Fatalf("attempt %d of the burst refused", i)
		}
	}
	if l.allow("a") {
		t.Fatalf("an attempt past the burst allowed")
	}

	// clients have their own buckets
	if !l.allow("b") {
		t.Fatalf("another client refused")
	}

	// tokens come back at the rate, up to the burst
	now = now.Add(500 * time.Millisecond)
	if !l.allow("a") || l.allow("a") {
		t.Fatalf("half a second at 2/s should give back exactly one attempt")
	}
	now = now.Add(time.Hour)
	for i := 0; i < 3; i++ {
		if !l.allow("a") {
			t.Fatalf("after a long rest, attempt %d refused", i)
		}
	}
	if l.allow("a") {
		t.Fatalf("a long rest gave back more than the burst")
	}

	// a bucket that has refilled is forgotten
	now = now.Add(time.Hour)
	l.allow("c")
	if _, ok := l.clients["b"]; ok {
		t.Fatalf("an idle client's bucket was kept")
	}
}
