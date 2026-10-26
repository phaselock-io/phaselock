package main

// The cgo binding to the C core.  cgo compiles the core's C here, and each vendored library in its
// own package under internal/, so the build cache keeps the libraries' object code across edits
// to this package.  -fwrapv, which QuickJS needs for signed overflow to wrap, is outside cgo's
// default flag allowlist, so building takes CGO_CFLAGS_ALLOW=-fwrapv in the environment.  On
// Windows, MinGW's pthreads link statically, since Windows does not ship their DLL.

/*
#cgo CFLAGS: -std=gnu11 -O2 -fwrapv -DMPACK_EXTENSIONS=1
#cgo CFLAGS: -I${SRCDIR}/third_party/mpack -I${SRCDIR}/third_party/sha256
#cgo CFLAGS: -I${SRCDIR}/third_party/quickjs -I${SRCDIR}/third_party/sqlite
#cgo linux LDFLAGS: -lm -pthread
#cgo darwin LDFLAGS: -lm
#cgo windows LDFLAGS: -lbcrypt -Wl,-Bstatic -lpthread -Wl,-Bdynamic
#include <stdlib.h>
#include "pldb.h"

pldb_hash_fn pldb_go_hasher(void);
*/
import "C"

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"runtime/cgo"
	"time"
	"unsafe"

	// the vendored C libraries the core links against
	_ "phaselock.io/phaselockdb/internal/mpack"
	_ "phaselock.io/phaselockdb/internal/quickjs"
	_ "phaselock.io/phaselockdb/internal/sha256"
	_ "phaselock.io/phaselockdb/internal/sqlite"
)

// the JS host's source, which the core evaluates before the bundle
//
//go:embed host.js
var hostJS string

type core struct {
	db *C.pldb
}

type principal struct {
	anonymous bool
	user      string
	gen       int64 // -1 skips the generation check
}

// item is one edit of the log: its wire encoding, the slice it edits, and the position of its
// mutation, which the mutation's other edits share.
type item struct {
	slice    string
	position uint64
	data     []byte
}

type result struct {
	kind      int
	status    int
	reqid     uint64
	conn      uint64
	position  uint64
	items     []item
	buf       []byte
	token     string
	selectors []string
	marks     []int64 // every cron entry's mark, in Unix seconds
	errmsg    string
	// an outcome that stopped at a proven mutation whose credentials changed: buf holds the
	// outcomes before it, and hash what lookup answers now, nil for none
	bounce bool
	hash   *string
}

// verdict is a mutation's proof as checked: whether it carries one, and if so whether it passed
// against hash, the password hash lookup answered for the sender's token, nil for none
type verdict struct {
	state int
	hash  *string
}

const (
	proofNone   = C.PLDB_PROOF_NONE
	proofPassed = C.PLDB_PROOF_PASSED
	proofFailed = C.PLDB_PROOF_FAILED

	// how many times a call may bounce before the writer takes a changed hash for lookup's bug
	maxBounces = C.PLDB_MAX_BOUNCES
)

const (
	rShutdown = C.PLDB_R_SHUTDOWN
	rCommit   = C.PLDB_R_COMMIT
	rOutcome  = C.PLDB_R_OUTCOME
	rView     = C.PLDB_R_VIEW
	rLookup   = C.PLDB_R_LOOKUP
	rArm      = C.PLDB_R_ARM
	rTick     = C.PLDB_R_TICK
	rKey      = C.PLDB_R_KEY
)

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// openCore opens the core with a page cache of cacheMiB for each SQLite connection; on an empty
// log, its bootstrap may read the env variables named
func openCore(dir, bundle string, env []string, cacheMiB int) (*core, error) {
	cdir, cbundle := C.CString(dir), C.CString(bundle)
	defer C.free(unsafe.Pointer(cdir))
	defer C.free(unsafe.Pointer(cbundle))
	cenv := cstrings(env)
	defer freeStrings(cenv, len(env))
	var db *C.pldb
	errbuf := make([]byte, 2048)
	chost := C.CString(hostJS)
	defer C.free(unsafe.Pointer(chost))
	rc := C.pldb_open(cdir, chost, C.size_t(len(hostJS)), cbundle, C.pldb_go_hasher(), cenv, C.int(len(env)),
		C.int(cacheMiB), &db, (*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf)))
	if rc != 0 {
		return nil, errors.New(cstr(errbuf))
	}
	return &core{db: db}, nil
}

func cstr(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

func (c *core) close() { C.pldb_close(c.db) }

func (c *core) epoch() string { return C.GoString(C.pldb_epoch(c.db)) }

// cstrings builds a NULL-free C array of C strings; free with freeStrings.
func cstrings(ss []string) **C.char {
	arr := (**C.char)(C.malloc(C.size_t(len(ss)+1) * C.size_t(unsafe.Sizeof(uintptr(0)))))
	slice := unsafe.Slice(arr, len(ss)+1)
	for i, s := range ss {
		slice[i] = C.CString(s)
	}
	slice[len(ss)] = nil
	return arr
}

func freeStrings(arr **C.char, n int) {
	slice := unsafe.Slice(arr, n+1)
	for i := 0; i < n; i++ {
		C.free(unsafe.Pointer(slice[i]))
	}
	C.free(unsafe.Pointer(arr))
}

func withPrincipal(p principal, fn func(user *C.char, gen C.int64_t)) {
	var user *C.char
	if !p.anonymous {
		user = C.CString(p.user)
		defer C.free(unsafe.Pointer(user))
	}
	fn(user, C.int64_t(p.gen))
}

func cbytes(b []byte) (*C.uint8_t, C.size_t) {
	if len(b) == 0 {
		return nil, 0
	}
	return (*C.uint8_t)(unsafe.Pointer(&b[0])), C.size_t(len(b))
}

// submit hands the writer prepared mutations with their verdicts, one per mutation or none, and
// the number of times the call has bounced
func (c *core) submit(reqid uint64, p principal, body []byte, verdicts []verdict, attempt int) {
	var arr *C.pldb_verdict
	if len(verdicts) > 0 {
		arr = (*C.pldb_verdict)(C.calloc(C.size_t(len(verdicts)), C.size_t(unsafe.Sizeof(C.pldb_verdict{}))))
		defer C.free(unsafe.Pointer(arr))
		cv := unsafe.Slice(arr, len(verdicts))
		for i, v := range verdicts {
			cv[i].state = C.int(v.state)
			if v.hash != nil {
				cv[i].hash = C.CString(*v.hash)
				defer C.free(unsafe.Pointer(cv[i].hash))
			}
		}
	}
	withPrincipal(p, func(user *C.char, gen C.int64_t) {
		ptr, l := cbytes(body)
		C.pldb_submit(c.db, C.uint64_t(reqid), user, gen, ptr, l, arr, C.size_t(len(verdicts)),
			C.int(attempt))
	})
}

func (c *core) register(reqid, conn uint64, p principal) {
	withPrincipal(p, func(user *C.char, gen C.int64_t) {
		C.pldb_register(c.db, C.uint64_t(reqid), C.uint64_t(conn), user, gen)
	})
}

// tests only: while held, the core takes no batch, so the requests queued meanwhile land in one
func (c *core) holdBatches(hold bool) {
	h := C.int(0)
	if hold {
		h = 1
	}
	C.pldb_hold_batches(c.db, h)
}

// tests only: how many requests are queued for the core's next batch
func (c *core) queued() int {
	return int(C.pldb_queued(c.db))
}

func (c *core) unregister(conn uint64) {
	C.pldb_unregister(c.db, C.uint64_t(conn))
}

func (c *core) lookup(reqid uint64, ident []byte) {
	ptr, l := cbytes(ident)
	C.pldb_lookup(c.db, C.uint64_t(reqid), ptr, l)
}

// cronEntry is one entry of a cron install, as the bundle names it.
type cronEntry struct {
	install, name, spec string
}

// cronEntries are the bundle's cron entries, in the order the core numbers them.
func (c *core) cronEntries() []cronEntry {
	var arr *C.pldb_cron_entry
	n := C.pldb_cron_entries(c.db, &arr)
	if n == 0 {
		return nil
	}
	out := make([]cronEntry, int(n))
	for i, e := range unsafe.Slice(arr, int(n)) {
		out[i] = cronEntry{C.GoString(e.install), C.GoString(e.entry), C.GoString(e.spec)}
	}
	return out
}

// keys reads every stored token key, oldest first
func (c *core) keys() ([]tokenKey, error) {
	var arr *C.pldb_key
	var n C.size_t
	if C.pldb_keys(c.db, &arr, &n) != 0 {
		return nil, errors.New("reading the token keys failed")
	}
	defer C.pldb_keys_free(arr, n)
	out := make([]tokenKey, int(n))
	if n > 0 {
		for i, k := range unsafe.Slice(arr, int(n)) {
			out[i] = tokenKey{
				kid:    C.GoString(k.kid),
				pub:    C.GoBytes(unsafe.Pointer(k.pub), C.int(k.len)),
				minted: time.UnixMilli(int64(k.minted)),
			}
		}
	}
	return out, nil
}

// addKey stores a token key and deletes the keys sweep names, in one commit on the writer
func (c *core) addKey(reqid uint64, k tokenKey, sweep []string) {
	kid := C.CString(k.kid)
	defer C.free(unsafe.Pointer(kid))
	pub := C.CBytes(k.pub)
	defer C.free(pub)
	ck := C.pldb_key{kid: kid, pub: (*C.uint8_t)(pub), len: C.size_t(len(k.pub)), minted: C.int64_t(k.minted.UnixMilli())}
	csweep := cstrings(sweep)
	defer freeStrings(csweep, len(sweep))
	C.pldb_key_add(c.db, C.uint64_t(reqid), &ck, csweep, C.size_t(len(sweep)))
}

func (c *core) cronArm(reqid uint64, minute time.Time) {
	C.pldb_cron_arm(c.db, C.uint64_t(reqid), C.int64_t(minute.Unix()))
}

func (c *core) cronTick(reqid uint64, i int, slot time.Time) {
	C.pldb_cron_tick(c.db, C.uint64_t(reqid), C.size_t(i), C.int64_t(slot.Unix()))
}

func goStrings(arr **C.char, n C.size_t) []string {
	if n == 0 {
		return nil
	}
	slice := unsafe.Slice(arr, int(n))
	out := make([]string, int(n))
	for i := range out {
		out[i] = C.GoString(slice[i])
	}
	return out
}

func goItems(arr *C.pldb_item, n C.size_t) []item {
	if n == 0 {
		return nil
	}
	slice := unsafe.Slice(arr, int(n))
	out := make([]item, int(n))
	for i := range out {
		out[i] = item{
			slice:    C.GoString(slice[i].slice),
			position: uint64(slice[i].position),
			data:     C.GoBytes(unsafe.Pointer(slice[i].data), C.int(slice[i].len)),
		}
	}
	return out
}

// pop blocks until the core produces a result.
func (c *core) pop() result {
	r := C.pldb_pop(c.db)
	defer C.pldb_result_free(r)
	out := result{
		kind:      int(r.kind),
		status:    int(r.status),
		reqid:     uint64(r.reqid),
		conn:      uint64(r.conn),
		position:  uint64(r.position),
		items:     goItems(r.items, r.nitems),
		selectors: goStrings(r.selectors, r.nselectors),
	}
	if r.buf != nil {
		out.buf = C.GoBytes(unsafe.Pointer(r.buf), C.int(r.len))
	}
	if r.errmsg != nil {
		out.errmsg = C.GoString(r.errmsg)
	}
	out.bounce = r.bounce != 0
	if r.hash != nil {
		h := C.GoString(r.hash)
		out.hash = &h
	}
	if r.nmarks > 0 {
		for _, m := range unsafe.Slice(r.marks, int(r.nmarks)) {
			out.marks = append(out.marks, int64(m))
		}
	}
	return out
}

// prepared is a request as the core checked and prepared it
type prepared struct {
	body    []byte
	reasons []string // one per mutation of the request, "" for one that passed
	// for each passing mutation, in body order: its start in body, and the password of each
	// MutationAuth proof it carries
	offsets []int
	proofs  [][]string
}

var errTooMany = errors.New("the request carries more mutations than the database takes in one")

// prepare checks every mutation of a request against the bundle's registry and prepares the
// fields the database replaces before the decider runs, hashing passwords on the pool for client
// under ctx, and setting each MutationAuth proof's password aside for the caller to check.  It
// returns errTooMany for a request of more than max mutations, checking none of them, and errBusy
// or errLimited when a hash was refused, which refuses the whole request.
func (c *core) prepare(s *Server, ctx context.Context, client string, body []byte, max int) (*prepared, error) {
	call := cgo.NewHandle(&hashCall{s: s, ctx: ctx, client: client})
	defer call.Delete()
	ptr, l := cbytes(body)
	var out C.pldb_prepared
	errbuf := make([]byte, 512)
	rc := C.pldb_prepare(c.db, C.uintptr_t(call), ptr, l, C.size_t(max), &out, (*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf)))
	switch rc {
	case 0:
	case C.PLDB_TOO_MANY:
		return nil, errTooMany
	case C.PLDB_HASH_BUSY:
		return nil, errBusy
	case C.PLDB_HASH_LIMITED:
		return nil, errLimited
	default:
		return nil, errors.New(cstr(errbuf))
	}
	defer C.pldb_prepared_free(&out)
	pc := &prepared{reasons: make([]string, int(out.n))}
	if out.body != nil {
		pc.body = C.GoBytes(unsafe.Pointer(out.body), C.int(out.len))
	}

	// each passing mutation's start, and the index in body order of each mutation of the request
	order := make([]int, int(out.n))
	if out.n > 0 {
		reasons := unsafe.Slice(out.reasons, int(out.n))
		offsets := unsafe.Slice(out.offsets, int(out.n))
		for i := range pc.reasons {
			if reasons[i] != nil {
				pc.reasons[i] = C.GoString(reasons[i])
				continue
			}
			order[i] = len(pc.offsets)
			pc.offsets = append(pc.offsets, int(offsets[i]))
		}
	}

	// each proof's password, under its mutation
	pc.proofs = make([][]string, len(pc.offsets))
	if out.nproofs > 0 {
		for _, p := range unsafe.Slice(out.proofs, int(out.nproofs)) {
			j := order[int(p.mutation)]
			pc.proofs[j] = append(pc.proofs[j], C.GoString(p.password))
		}
	}
	return pc, nil
}

// readLog reads the log's edits with from <= position <= to.
func (c *core) readLog(from, to uint64) ([]item, error) {
	if from > to {
		return nil, nil
	}
	var items *C.pldb_item
	var n C.size_t
	if C.pldb_read_log(c.db, C.uint64_t(from), C.uint64_t(to), &items, &n) != 0 {
		return nil, errors.New("read_log failed")
	}
	defer C.pldb_items_free(items, n)
	return goItems(items, n), nil
}

// readEdits reads a selector's edits with from < position < to, ascending or descending: limit of
// them and the rest of the last one's position, or fewer when the range runs out.
func (c *core) readEdits(selector string, from, to uint64, reverse bool, limit int) ([]item, error) {
	if from+1 >= to {
		return nil, nil
	}
	cselector := C.CString(selector)
	defer C.free(unsafe.Pointer(cselector))
	rev := C.int(0)
	if reverse {
		rev = 1
	}
	var items *C.pldb_item
	var n C.size_t
	if C.pldb_read_edits(c.db, cselector, C.uint64_t(from), C.uint64_t(to), rev, C.size_t(limit), &items, &n) != 0 {
		return nil, errors.New("read_edits failed")
	}
	defer C.pldb_items_free(items, n)
	return goItems(items, n), nil
}

func (c *core) snapshot(selector string) ([]byte, uint64, error) {
	cselector := C.CString(selector)
	defer C.free(unsafe.Pointer(cselector))
	var out *C.uint8_t
	var outlen C.size_t
	var position C.uint64_t
	if C.pldb_snapshot(c.db, cselector, &out, &outlen, &position) != 0 {
		return nil, 0, fmt.Errorf("snapshot %s failed", selector)
	}
	defer C.pldb_free(unsafe.Pointer(out))
	return C.GoBytes(unsafe.Pointer(out), C.int(outlen)), uint64(position), nil
}

// hashCall is what a prepare call hands its hash callbacks: the server and the request
type hashCall struct {
	s      *Server
	ctx    context.Context
	client string
}

// goHashPassword hashes for the request its argument names, on the pool within the client's
// budget; for bootstrap, which has no request and runs before anything is served, the argument
// is zero, and the hash runs at once.
//
//export goHashPassword
func goHashPassword(arg C.uintptr_t, pw *C.char, n C.size_t, out *C.char, capacity C.size_t) C.int {
	var h string
	var err error
	if arg == 0 {
		h = hashPassword(C.GoStringN(pw, C.int(n)))
	} else {
		call := cgo.Handle(arg).Value().(*hashCall)
		h, err = call.s.hashFor(call.ctx, call.client, C.GoStringN(pw, C.int(n)))
	}
	switch {
	case errors.Is(err, errLimited):
		return C.PLDB_HASH_LIMITED
	case err != nil:
		return C.PLDB_HASH_BUSY
	case len(h)+1 > int(capacity):
		return C.PLDB_HASH_FAILED
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(out)), int(capacity))
	copy(dst, h)
	dst[len(h)] = 0
	return C.PLDB_HASH_OK
}
