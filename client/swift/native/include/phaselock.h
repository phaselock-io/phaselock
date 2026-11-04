/* The C ABI of PhaseLock's native host, as phaselock-swift builds it.  Every argument and answer
   is msgpack bytes, under the request protocol of client/native/src/api.rs:

   - pl_open loads a native bundle under its limits, [stack, memory, callMillis], answering
     ["ok", host] or ["error", message];
   - pl_call runs one request, [op, ...args], answering ["ok", delay, events], ["error",
     message], or ["ended", message];
   - pl_close frees a host and closes every store it holds.

   Every answer is the caller's to free with pl_free.  A host is used only from the thread that
   opened it. */

#ifndef PHASELOCK_H
#define PHASELOCK_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *ptr;
    size_t len;
} PlBytes;

PlBytes pl_open(const uint8_t *bundle, size_t bundle_len, const uint8_t *name, size_t name_len,
                const uint8_t *limits, size_t limits_len);
PlBytes pl_call(int64_t host, const uint8_t *request, size_t request_len);
void pl_close(int64_t host);
void pl_free(PlBytes bytes);

#endif
