package main

// Password hashing: argon2id runs on a fixed pool of workers behind a bounded queue, so its
// memory stays at the pool's size times one hash's, and a per-client token bucket in front of
// the pool keeps one client from filling the queue.

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	errBusy    = errors.New("password hashing is busy; try again")
	errLimited = errors.New("too many password attempts; slow down")
	errClosed  = errors.New("the server is shutting down")
)

type hashJob struct {
	ctx   context.Context
	run   func()
	reply chan struct{}
}

// hashPool runs jobs on a fixed number of workers.  A job waits in a bounded queue; one whose
// client has left by the time a worker reaches it is skipped.  When the pool's context ends,
// the workers finish the job in hand and take no more.
type hashPool struct {
	ctx  context.Context
	jobs chan hashJob
	wg   sync.WaitGroup
}

func newHashPool(ctx context.Context, workers, queue int) *hashPool {
	p := &hashPool{ctx: ctx, jobs: make(chan hashJob, queue)}
	for range workers {
		p.wg.Add(1)
		go p.work()
	}
	return p
}

func (p *hashPool) work() {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			return
		case j := <-p.jobs:
			// a job taken as the pool stops, or whose client has left, is skipped
			if p.ctx.Err() != nil || j.ctx.Err() != nil {
				continue
			}
			j.run()
			j.reply <- struct{}{}
		}
	}
}

// do runs fn on a worker and waits for it: errBusy when the queue is full, errClosed when the
// pool has stopped, and the context's error when the client leaves first.
func (p *hashPool) do(ctx context.Context, fn func()) error {
	if p.ctx.Err() != nil {
		return errClosed
	}
	j := hashJob{ctx: ctx, run: fn, reply: make(chan struct{}, 1)}
	select {
	case p.jobs <- j:
	default:
		return errBusy
	}
	select {
	case <-j.reply:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-p.ctx.Done():
		return errClosed
	}
}

// wait blocks until every worker has exited, after the pool's context ends
func (p *hashPool) wait() { p.wg.Wait() }

// limiter is a token bucket per client: each holds up to burst tokens and regains rate per
// second, and an attempt spends one.  A bucket that has refilled is forgotten.
type limiter struct {
	mu        sync.Mutex
	rate      float64
	burst     float64
	clients   map[string]*bucket
	now       func() time.Time
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(rate float64, burst int) *limiter {
	return &limiter{rate: rate, burst: float64(burst), clients: map[string]*bucket{}, now: time.Now}
}

// allow spends one of the client's tokens, or reports that none is left
func (l *limiter) allow(client string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweep(now)
	b := l.clients[client]
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.clients[client] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.at).Seconds()*l.rate)
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweep forgets the buckets that have refilled, at most once a minute
func (l *limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now
	for client, b := range l.clients {
		if b.tokens+now.Sub(b.at).Seconds()*l.rate >= l.burst {
			delete(l.clients, client)
		}
	}
}

// hashFor hashes a password for a client, within its budget, on the pool
func (s *Server) hashFor(ctx context.Context, client, pw string) (string, error) {
	if !s.limit.allow(client) {
		return "", errLimited
	}
	var hash string
	err := s.hashes.do(ctx, func() { hash = hashPassword(pw) })
	return hash, err
}

// verifyFor runs a password check for a client, within its budget, on the pool
func (s *Server) verifyFor(ctx context.Context, client string, check func() bool) (bool, error) {
	if !s.limit.allow(client) {
		return false, errLimited
	}
	var ok bool
	err := s.hashes.do(ctx, func() { ok = check() })
	return ok, err
}
