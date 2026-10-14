// Package quickjs compiles the vendored QuickJS, which the C core links against.  Each lib_*.c
// wrapper sets the defines QuickJS's own build passes and includes one of its C files.
package quickjs

// -fwrapv makes signed overflow wrap, which QuickJS relies on

/*
#cgo CFLAGS: -std=gnu11 -O2 -fwrapv
*/
import "C"
