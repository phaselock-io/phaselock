// Package mpack compiles the vendored MPack, which the C core links against.
package mpack

// the core uses MPack's extensions, and every file that includes mpack.h must agree on them

/*
#cgo CFLAGS: -std=gnu11 -O2 -DMPACK_EXTENSIONS=1
*/
import "C"
