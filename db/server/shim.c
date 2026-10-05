#include "_cgo_export.h"
#include "pldb.h"

pldb_hash_fn pldb_go_hasher(void) { return (pldb_hash_fn)goHashPassword; }
