package main

// Test only: the scan conformance test's hold on the core's pattern walk, through the C core's
// pldb_scantest.  Nothing the server runs calls it.

/*
#include <stdlib.h>
#include "pldb.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

type scanTest struct {
	t *C.pldb_scantest
}

// openScanTest opens the bundle's JS host over a fresh store at path, its scans stepping through
// budget keys before a seek, or the core's own number for a negative budget.
func openScanTest(bundle, path string, budget int) (*scanTest, error) {
	cbundle, cpath := C.CString(bundle), C.CString(path)
	defer C.free(unsafe.Pointer(cbundle))
	defer C.free(unsafe.Pointer(cpath))
	errbuf := make([]byte, 2048)
	chost := C.CString(hostJS)
	defer C.free(unsafe.Pointer(chost))
	t := C.pldb_scantest_open(chost, C.size_t(len(hostJS)), cbundle, cpath, C.int(budget),
		(*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf)))
	if t == nil {
		return nil, errors.New(cstr(errbuf))
	}
	return &scanTest{t: t}, nil
}

func (s *scanTest) close() { C.pldb_scantest_close(s.t) }

// put stores a string value under key, converted under typ, past the write gate.
func (s *scanTest) put(key, typ, value string) error {
	ckey, ctyp, cval := C.CString(key), C.CString(typ), C.CString(value)
	defer C.free(unsafe.Pointer(ckey))
	defer C.free(unsafe.Pointer(ctyp))
	defer C.free(unsafe.Pointer(cval))
	errbuf := make([]byte, 512)
	if C.pldb_scantest_put(s.t, ckey, ctyp, cval, (*C.char)(unsafe.Pointer(&errbuf[0])), C.size_t(len(errbuf))) != 0 {
		return errors.New(cstr(errbuf))
	}
	return nil
}

// scan answers a ReadScan given as JSON with its batch as JSON, or with what it threw.
func (s *scanTest) scan(req []byte) ([]byte, error) {
	creq := C.CString(string(req))
	defer C.free(unsafe.Pointer(creq))
	var failed C.int
	out := C.pldb_scantest_scan(s.t, creq, &failed)
	defer C.pldb_free(unsafe.Pointer(out))
	text := C.GoString(out)
	if failed != 0 {
		return nil, errors.New(text)
	}
	return []byte(text), nil
}
