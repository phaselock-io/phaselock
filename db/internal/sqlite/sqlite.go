// Package sqlite compiles the vendored SQLite amalgamation, which the C core links against.  Its
// lib_sqlite3.c wrapper sets the defines SQLite's own build passes and includes it.
package sqlite

/*
#cgo CFLAGS: -std=gnu11 -O2
*/
import "C"
