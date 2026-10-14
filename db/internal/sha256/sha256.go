// Package sha256 compiles the vendored SHA-256 from crypto-algorithms, which the C core links
// against.
package sha256

/*
#cgo CFLAGS: -std=gnu11 -O2
*/
import "C"
