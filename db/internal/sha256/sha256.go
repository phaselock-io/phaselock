// Package sha256 compiles the vendored SHA-256 from crypto-algorithms, which the C core links
// against.
package sha256

// -fwrapv defines the shift of a byte into an int's sign bit, which the message schedule makes

/*
#cgo CFLAGS: -std=gnu11 -O2 -fwrapv
*/
import "C"
