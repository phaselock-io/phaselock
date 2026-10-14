/* The operating system calls that differ between Linux, macOS, and Windows. */

#include <errno.h>

#include "internal.h"

#if defined(_WIN32)
#include <windows.h>
#include <bcrypt.h>
#include <direct.h>
#elif defined(__APPLE__)
#include <sys/random.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#else
#include <sys/random.h>
#include <sys/stat.h>
#include <time.h>
#endif

int os_random(void *buf, size_t n) {
#if defined(_WIN32)
    // the system's preferred generator, in one call
    NTSTATUS st = BCryptGenRandom(NULL, buf, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    return BCRYPT_SUCCESS(st) ? 0 : -1;
#elif defined(__APPLE__)
    // getentropy fills at most 256 bytes a call
    for (size_t got = 0; got < n;) {
        size_t chunk = n - got < 256 ? n - got : 256;
        if (getentropy((unsigned char *)buf + got, chunk)) return -1;
        got += chunk;
    }
    return 0;
#else
    for (size_t got = 0; got < n;) {
        ssize_t r = getrandom((unsigned char *)buf + got, n - got, 0);
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        got += (size_t)r;
    }
    return 0;
#endif
}

int64_t now_ms(void) {
#if defined(_WIN32)
    // 100ns intervals since 1601, moved to milliseconds since 1970
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (int64_t)(t / 10000) - 11644473600000LL;
#else
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
#endif
}

int os_mkdir(const char *path) {
#if defined(_WIN32)
    int rc = _mkdir(path);
#else
    int rc = mkdir(path, 0755);
#endif
    return rc && errno != EEXIST ? -1 : 0;
}
