package main

// The cgo binding to the C core.

/*
#cgo CFLAGS: -I${SRCDIR}/../core
#cgo LDFLAGS: ${SRCDIR}/../core/libpldb.a -lsqlite3 -lm -lpthread
#include <stdlib.h>
#include "pldb.h"

pldb_hash_fn pldb_go_hasher(void);
*/
import "C"

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"runtime/cgo"
	"unsafe"
)

type core struct {
	db *C.pldb
}

type principal struct {
	anonymous bool
	user      string
	gen       int64 // -1 skips the generation check
}

// item is one event of the log: its encoded [envelope, data] value, and atom the first position
// of the atom it belongs to.
type item struct {
	stream   string
	atom     uint64
	position uint64
	data     []byte
}

type result struct {
	kind     int
	status   int
	reqid    uint64
	conn     uint64
	position uint64
	items    []item
	buf      []byte
	token    string
	prefixes []string
	errmsg   string
}

const (
	rShutdown = C.PLDB_R_SHUTDOWN
	rCommit   = C.PLDB_R_COMMIT
	rOutcome  = C.PLDB_R_OUTCOME
	rView     = C.PLDB_R_VIEW
	rLookup   = C.PLDB_R_LOOKUP
)

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// openCore opens the core; on an empty log, its bootstrap may read the env variables named
func openCore(dir, bundle string, env []string) (*core, error) {
	cdir, cbundle := C.CString(dir), C.CString(bundle)
	defer C.free(unsafe.Pointer(cdir))
	defer C.free(unsafe.Pointer(cbundle))
	cenv := cstrings(env)
	defer freeStrings(cenv, len(env))
	var db *C.pldb
	errbuf := make([]byte, 2048)
	rc := C.pldb_open(cdir, cbundle, C.pldb_go_hasher(), cenv, C.int(len(env)), &db,
		(*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf)))
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

func (c *core) submit(reqid uint64, p principal, body []byte) {
	withPrincipal(p, func(user *C.char, gen C.int64_t) {
		ptr, l := cbytes(body)
		C.pldb_submit(c.db, C.uint64_t(reqid), user, gen, ptr, l)
	})
}

func (c *core) register(reqid, conn uint64, p principal) {
	withPrincipal(p, func(user *C.char, gen C.int64_t) {
		C.pldb_register(c.db, C.uint64_t(reqid), C.uint64_t(conn), user, gen)
	})
}

func (c *core) unregister(conn uint64) {
	C.pldb_unregister(c.db, C.uint64_t(conn))
}

func (c *core) lookup(reqid uint64, ident []byte) {
	ptr, l := cbytes(ident)
	C.pldb_lookup(c.db, C.uint64_t(reqid), ptr, l)
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
			stream:   C.GoString(slice[i].stream),
			atom:     uint64(slice[i].atom),
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
		kind:     int(r.kind),
		status:   int(r.status),
		reqid:    uint64(r.reqid),
		conn:     uint64(r.conn),
		position: uint64(r.position),
		items:    goItems(r.items, r.nitems),
		prefixes: goStrings(r.prefixes, r.nprefixes),
	}
	if r.buf != nil {
		out.buf = C.GoBytes(unsafe.Pointer(r.buf), C.int(r.len))
	}
	if r.errmsg != nil {
		out.errmsg = C.GoString(r.errmsg)
	}
	return out
}

// prepare checks every command of a request against the bundle's registry and prepares the
// fields the database replaces before precommit, hashing passwords on the pool for client under
// ctx.  It returns the body of the commands that passed, in order, and one reason per command of
// the request, "" for a command that passed; errBusy or errLimited when a hash was refused, which
// refuses the whole request.
func (c *core) prepare(s *Server, ctx context.Context, client string, body []byte) ([]byte, []string, error) {
	call := cgo.NewHandle(&hashCall{s: s, ctx: ctx, client: client})
	defer call.Delete()
	ptr, l := cbytes(body)
	var out C.pldb_prepared
	errbuf := make([]byte, 512)
	rc := C.pldb_prepare(c.db, C.uintptr_t(call), ptr, l, &out, (*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf)))
	switch rc {
	case 0:
	case C.PLDB_HASH_BUSY:
		return nil, nil, errBusy
	case C.PLDB_HASH_LIMITED:
		return nil, nil, errLimited
	default:
		return nil, nil, errors.New(cstr(errbuf))
	}
	defer C.pldb_prepared_free(&out)
	reasons := make([]string, int(out.n))
	if out.n > 0 {
		slice := unsafe.Slice(out.reasons, int(out.n))
		for i := range reasons {
			if slice[i] != nil {
				reasons[i] = C.GoString(slice[i])
			}
		}
	}
	var prepared []byte
	if out.body != nil {
		prepared = C.GoBytes(unsafe.Pointer(out.body), C.int(out.len))
	}
	return prepared, reasons, nil
}

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

// readAtoms reads the log from `from` through `to` and on to the end of the atom that `to`
// falls in, so a window over the log never ends partway through an atom.  `from` must be the
// first position of an atom.
func (c *core) readAtoms(from, to uint64) ([]item, error) {
	items, err := c.readLog(from, to)
	if err != nil || len(items) == 0 {
		return items, err
	}

	// peek at the next position, then read on a batch at a time while the atom continues
	step := uint64(1)
	for {
		last := items[len(items)-1]
		more, err := c.readLog(last.position+1, last.position+step)
		if err != nil {
			return nil, err
		}
		n := 0
		for n < len(more) && more[n].atom == last.atom {
			n++
		}
		items = append(items, more[:n]...)
		if n == 0 || n < len(more) {
			return items, nil
		}
		step = coldBatch
	}
}

func (c *core) readEvents(ref string, from, to uint64, reverse bool, limit int) ([]item, error) {
	if from+1 >= to {
		return nil, nil
	}
	cref := C.CString(ref)
	defer C.free(unsafe.Pointer(cref))
	rev := C.int(0)
	if reverse {
		rev = 1
	}
	var items *C.pldb_item
	var n C.size_t
	if C.pldb_read_events(c.db, cref, C.uint64_t(from), C.uint64_t(to), rev, C.size_t(limit), &items, &n) != 0 {
		return nil, errors.New("read_events failed")
	}
	defer C.pldb_items_free(items, n)
	return goItems(items, n), nil
}

func (c *core) snapshot(ref string) ([]byte, uint64, error) {
	cref := C.CString(ref)
	defer C.free(unsafe.Pointer(cref))
	var out *C.uint8_t
	var outlen C.size_t
	var position C.uint64_t
	if C.pldb_snapshot(c.db, cref, &out, &outlen, &position) != 0 {
		return nil, 0, fmt.Errorf("snapshot %s failed", ref)
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
