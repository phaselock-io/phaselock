package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"iter"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/kurrent-io/KurrentDB-Client-Go/kurrentdb"
	"github.com/google/uuid"
	"go.etcd.io/bbolt"

	"github.com/phaselock-io/phaselock/go/model"
)

//go:embed decider.js
var deciderScript string

const (
	booksStream = "books"
	patronStreamPrefix = "patron."
	statusStream = "status"
	vstatusStream = "vstatus"
	deciderStateStream = "decider-state"

	batchMax = 1000
)

// PublishedCheckpoint is the type of event we put into decider state
type PublishedCheckpoint struct {
	PublishedUntil uint64 `json:"publishedUntil"`
}

// Batch contains one or more events received from a subscription
type Batch struct {
	Events []goja.Value
	Checkpoint uint64
}

var storeBucket = []byte("store")

// NewBboltStore sets up a PhaseLock Store backed by bbolt.
func NewBboltStore(path string) (model.Store, error) {
	// the file lock is held by one process at a time; fail fast instead of waiting
	db, err := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	store, err := newBboltStore(db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func newBboltStore(db *bbolt.DB) (model.Store, error) {
	err := db.Update(func(tx *bbolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(storeBucket)
		return err
	})
	if err != nil {
		return nil, err
	}
	return model.NewGoStore(func(writable bool) (model.Txn, error) {
		tx, err := db.Begin(writable)
		if err != nil {
			return nil, err
		}
		return &BboltTxn{tx}, nil
	}), nil
}

type BboltTxn struct {
	tx *bbolt.Tx
}

func (t *BboltTxn) Commit() error {
	// the engine commits read transactions too; bbolt requires Rollback for those
	if !t.tx.Writable() {
		return t.tx.Rollback()
	}
	return t.tx.Commit()
}

func (t *BboltTxn) Abort() {
	_ = t.tx.Rollback()
}

func (t *BboltTxn) Get(key string) ([]byte, error) {
	// nil means absent; the slice is only valid until the transaction ends,
	// which is fine because the engine decodes it before then
	return t.tx.Bucket(storeBucket).Get([]byte(key)), nil
}

func (t *BboltTxn) Set(key string, val []byte) error {
	return t.tx.Bucket(storeBucket).Put([]byte(key), val)
}

func (t *BboltTxn) Del(key string) error {
	return t.tx.Bucket(storeBucket).Delete([]byte(key))
}


func setupEngine(
	deciderEvents *[]model.DeciderEvents,
) (*model.DeciderEngine, uint64, error) {
	// create an engine backed by a persistent local store
	store, err := NewBboltStore(".bbolt")
	if err != nil {
		return nil, 0, fmt.Errorf("opening store: %w", err)
	}
	eng, err := model.NewDeciderEngine(
		deciderScript,
		store,
		"deciderMigrate",
		"deciderReducer",
	)
	if err != nil {
		return nil, 0, fmt.Errorf("creating engine: %w", err)
	}

	// Enable queries immediately.  We manually control when we want to ignore the decider events
	// emitted by the query graph, based on where we are in the stream vs the last committed decider
	// events in the database; this Engine.caughtUp() mechanism is irrelevant to us.
	err = eng.CaughtUp()
	if err != nil {
		return nil, 0, err
	}

	// DEBUG //
	q := model.NewQuery(eng, func(vm *goja.Runtime, qx model.DeciderQueryContext) string {
		out := fmt.Sprintf("have books:\n")
		for isbn := range qx.Editions() {
			edition := qx.Edition(isbn)
			out += fmt.Sprintf("  - %v (x%v)\n", edition.Title(vm), len(edition.Books(vm)))
		}
		return out
	})
	q.Subscribe(func(out string) { print(out) })
	q = model.NewQuery(eng, func(vm *goja.Runtime, qx model.DeciderQueryContext) string {
		out := fmt.Sprintf("have patrons:\n")
		for id := range qx.Patrons() {
			patron := qx.Patron(id)
			out += fmt.Sprintf("  - %v, researcher=%v\n", patron.Name(vm), patron.Researcher(vm))
		}
		return out
	})
	q.Subscribe(func(out string) { print(out) })
	// END OF DEBUG //

	// query for the decider events emitted by our reducer
	query := model.NewQuery(eng, func(
		vm *goja.Runtime, qx model.DeciderQueryContext,
	) []model.DeciderEvents {
		out := qx.DeciderEvents()
		return out
	})

	// subscribe to the output of the query
	query.Subscribe(func(result []model.DeciderEvents) {
		// just save them for processing on the main thread
		*deciderEvents = result
	})

	// also request the current checkpoint status
	checkpoint, err := eng.Reconnect()
	if err != nil {
		return nil, 0, fmt.Errorf("requesting reconnect info: %w", err)
	}

	var checkpointOut uint64
	if checkpoint != nil {
		checkpointOut = *checkpoint
	}

	return eng, checkpointOut, nil
}

func setupKurrent(
	base context.Context, storeCheckpoint uint64,
) (
	*kurrentdb.Client,
	*kurrentdb.Subscription,
	uint64,
	kurrentdb.StreamState,
	func(),
	error,
) {
	connstr := "kurrentdb://admin:changeit@127.0.0.1:2113?tls=false"
	config, err := kurrentdb.ParseConnectionString(connstr)
	if err != nil {
		return nil, nil, 0, nil, nil, fmt.Errorf("parsing connection string: %w", err)
	}

	ctx, cancel := context.WithCancel(base)
	client, err := kurrentdb.NewClient(config)
	if err != nil {
		return nil, nil, 0, nil, nil, fmt.Errorf("NewClient: %w\n", err)
	}
	var sub *kurrentdb.Subscription

	cleanup := func(){
		if sub != nil {
			_ = sub.Close()
		}
		cancel()
		_ = client.Close()
	}

	success := false
	defer func(){
		if !success {
			cleanup()
		}
	}()

	// load the latest state we've published to the database
	reader, err := client.ReadStream(ctx, deciderStateStream, kurrentdb.ReadStreamOptions{
		Direction:      kurrentdb.Backwards,
		From:           kurrentdb.End{},
		RequiresLeader: true,
	}, 1)
	if err != nil {
		return nil, nil, 0, nil, nil, fmt.Errorf("reading decider-state: %w\n", err)
	}
	defer reader.Close()
	var dbCheckpoint uint64
	var revision kurrentdb.StreamState
	ev, err := reader.Recv()
	if err != nil {
		if kerr, ok := err.(*kurrentdb.Error); !ok && !kerr.IsErrorCode(
			kurrentdb.ErrorCodeResourceNotFound,
		) {
			return nil, nil, 0, nil, nil, fmt.Errorf("receiving from decider-state: %w\n", err)
		}
		// no checkpoint exists yet
		dbCheckpoint = 0
		revision = kurrentdb.NoStream{}
	} else {
		// checkpoint found
		var val PublishedCheckpoint
		err := json.Unmarshal(ev.Event.Data, &val)
		if err != nil {
			return nil, nil, 0, nil, nil, fmt.Errorf("unmarashaling published checkpoint: %w\n", err)
		}
		dbCheckpoint = val.PublishedUntil
		revision = kurrentdb.StreamRevision{ev.Event.EventNumber}
	}

	// start our subscription
	sub, err = client.SubscribeToAll(ctx, kurrentdb.SubscribeToAllOptions{
		From: kurrentdb.Position{storeCheckpoint, storeCheckpoint},
		ResolveLinkTos: true,
		Filter: &kurrentdb.SubscriptionFilter{
			Type: kurrentdb.StreamFilterType,
			Prefixes: []string{
				// decider reads books, patrons, and status events.
				// it will emit vstatus events, but it doesn't need to read those
				booksStream,
				patronStreamPrefix,
				statusStream,
			},
		},
		RequiresLeader: false,
		Authenticated: nil,
		Deadline: nil,
		MaxSearchWindow: 0, // ask for the default
		CheckpointInterval: 1000,
	})
	if err != nil {
		return nil, nil, 0, nil, nil, fmt.Errorf("subscribe: %w\n", err)
	}

	success = true
	return client, sub, dbCheckpoint, revision, cleanup, nil
}

// receive batches of events on a background thread and yield them to the caller
func recvBatches(
	vm *goja.Runtime, sub *kurrentdb.Subscription, dbCheckpoint uint64,
) iter.Seq2[Batch, error] {
	return func(yield func(Batch, error) bool) {
		// receive events in a background thread
		// use cond var because otherwise our catchup-vs-live logic requires copy-pasting a largeish
		// select statement and adding a `default` to one of them, so this turns out simpler.
		var recvd []kurrentdb.RecordedEvent
		var ckpt uint64
		var recvFail error
		live := false
		done := false
		var mutex sync.Mutex
		var cond = sync.NewCond(&mutex)

		// when this iterator closes, shut down the receiving goroutine
		defer func() {
			mutex.Lock()
			defer mutex.Unlock()
			done = true
			cond.Signal()
		}()

		recvOne := func() error {
			r := sub.Recv()
			if r.SubscriptionDropped != nil {
				return fmt.Errorf("SubscriptionDropped: %w", r.SubscriptionDropped.Error)
			}
			if r.CheckPointReached != nil {
				// TODO: we can't actually handle these yet because the engine does not accept
				// a checkpoint without events to process
				return nil
			}
			mutex.Lock()
			defer mutex.Unlock()
			switch true {
			case r.FellBehind != nil:
				live = false
			case r.CaughtUp != nil:
				live = true
			case r.EventAppeared != nil:
				recvd = append(recvd, *r.EventAppeared.Event)
				ckpt = r.EventAppeared.Event.Position.Commit
			default:
				panic("unexpected recv() result")
			}
			// alert the main thread
			cond.Signal()
			// Pause for backpressure, or in the special case of matching dbCheckpoint, which marks
			// the final event for which our decisions should be discarded.  That has to be the last
			// event in a batch so we can distinguish which decisions need discarding.
			if len(recvd) >= batchMax || ckpt == dbCheckpoint {
				// wait for main thread to consume recvd
				for !done && len(recvd) > 0 {
					cond.Wait()
				}
			}
			return nil
		}

		go func(){
			defer func() {
				if r := recover(); r != nil {
					if rErr, ok := r.(error); ok {
						recvFail = rErr
					} else {
						recvFail = fmt.Errorf("panicked: %v", r)
					}
				}
				cond.Signal()
			}()
			for {
				recvFail = recvOne()
				if recvFail != nil {
					return
				}
			}
		}()

		// gather up batches on this thread and yield them
		for {
			var recvd2 []kurrentdb.RecordedEvent
			var ckpt2 uint64
			func() {
				mutex.Lock()
				defer mutex.Unlock()
				for {
					if recvFail != nil { break }
					// if catching up: wait for batchMax events
					if !live && len(recvd) >= batchMax { break }
					// if live: return after the first event
					if live && len(recvd) > 0 { break }
					// if rebuilding cache: also break out when our batch shows ckpt == dbCheckpoint
					if ckpt == dbCheckpoint && dbCheckpoint > 0 && len(recvd) > 0 { break }
					// otherwise wait for the next event
					cond.Wait()
				}
				// capture recvd and ckpt while we have the lock
				recvd2 = recvd
				ckpt2 = ckpt
				recvd = nil
				// wakeup recvOne in case it is in backpressure
				cond.Signal()
			}()
			if recvFail != nil {
				yield(Batch{}, fmt.Errorf("receiver failed: %w", recvFail))
				return
			}

			// build a batch of goja values from raw recvd bytes
			batch := make([]goja.Value, len(recvd2))
			for i, r := range recvd2 {
				ev, err := model.JSONToGoja(vm, r.Data)
				if err != nil {
					yield(Batch{}, fmt.Errorf("json error: %w", err))
					return
				}
				// wrap the event data in some metadata
				obj := vm.NewObject()
				obj.Set("position", r.Position.Commit)
				obj.Set("id", r.EventID.String())
				obj.Set("data", ev)
				batch[i] = obj
			}

			if !yield(Batch{batch, ckpt2}, nil) { return }
		}
	}
}

func publishDecisions(
	ctx context.Context,
	client *kurrentdb.Client,
	deciderEvents []model.DeciderEvents,
	checkpoint uint64,
	revision kurrentdb.StreamState,
) (kurrentdb.StreamState, error) {
	if len(deciderEvents) == 0 {
		// nothing to publish
		return revision, nil
	}

	vstatusData := make([]kurrentdb.EventData, len(deciderEvents))
	for i, ev := range deciderEvents {
		data, err := json.Marshal(ev)
		println("publishing", string(data))
		if err != nil {
			return revision, fmt.Errorf("marshaling publish message (%v): %w", ev, err)
		}
		// we can get the event type from the event itself
		vstatusData[i] = kurrentdb.EventData{
			EventID:     uuid.New(),
			EventType:   "DeciderEvents",  // TODO: add some tooling for exposing this
			ContentType: kurrentdb.ContentTypeJson,
			Data:        data,
			Metadata:    nil,
		}
	}

	checkpointData, err := json.Marshal(PublishedCheckpoint{checkpoint})
	if err != nil {
		return revision, fmt.Errorf("marshaling checkpoint", err)
	}

	reqs := slices.Values([]kurrentdb.AppendStreamRequest{
		{
			StreamName:          vstatusStream,
			ExpectedStreamState: kurrentdb.Any{},
			Events:              slices.Values(vstatusData),
		},
		{
			StreamName:          deciderStateStream,
			ExpectedStreamState: revision,
			Events: slices.Values([]kurrentdb.EventData{{
				EventID:     uuid.New(),
				EventType:   "PublishedCheckpoint",
				ContentType: kurrentdb.ContentTypeJson,
				Data:        checkpointData,
				Metadata:    nil,
			}}),
		},
	})

	resp, err := client.MultiStreamAppend(ctx, reqs)
	if err != nil {
		return revision, fmt.Errorf("publishing decisions: %w", err)
	}
	var out *kurrentdb.StreamRevision
	for _, r := range resp.Responses {
		if r.Stream == deciderStateStream {
			out = &kurrentdb.StreamRevision{uint64(r.StreamRevision)}
		}
	}
	if out == nil {
		return revision, fmt.Errorf("did not find decider-state stream in response: %v", resp)
	}

	return *out, nil
}

func run(ctx context.Context) error {
	// set up the engine
	var deciderEvents []model.DeciderEvents
	eng, storeCheckpoint, err := setupEngine(&deciderEvents)
	if err != nil {
		return err
	}

	// now connect to the database
	client, sub, dbCheckpoint, revision, cleanup, err := setupKurrent(ctx, storeCheckpoint)
	if err != nil {
		return err
	}
	defer cleanup()

	// note that dbCheckpoint could be any of:
	//
	// - less than our storeCheckpoint, if we died before writing to the db; in this case we
	//   should publish our inital deciderEvents because they haven't been published yet.
	//
	// - equal to our storeCheckpoint, if we died after writing to the db; in this case we can
	//   discard the initial deciderEvents because they've already been published.
	//
	// - greater than our storeCheckpoint, if we rebuilt our cache or another decider ran; in
	//   this case we need to spend some time catching up our cache without publishing anything.

	if dbCheckpoint < storeCheckpoint {
		// we have unpublished decisions in our cache
		revision, err = publishDecisions(ctx, client, deciderEvents, storeCheckpoint, revision)
		if err != nil {
			return err
		}
	}

	// iterate through batches of events
	for batch, err := range recvBatches(eng.VM(), sub, dbCheckpoint) {
		if err != nil {
			return err
		}

		// push a batch into the engine
		err = eng.RecvEvents(batch.Events)
		if err != nil {
			return err
		}

		// then publish any decisions that came out (unless we're still rebuilding the cache)
		if batch.Checkpoint > dbCheckpoint {
			revision, err = publishDecisions(ctx, client, deciderEvents, batch.Checkpoint, revision)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

func main() {
	err := run(context.Background())
	if err != nil {
		if s, ok := err.(fmt.Stringer); ok {
			// String()-able errors, including *goja.Exception
			// (which only prints the stack trace with .String())
			fmt.Fprintf(os.Stderr, "fail: %v\n", s.String())
		} else {
			// normal errors
			fmt.Fprintf(os.Stderr, "fail: %v\n", err)
		}
		os.Exit(1)
	}
}
