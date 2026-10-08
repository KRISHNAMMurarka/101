#ifndef ONE01_RSS_RUNTIME_H
#define ONE01_RSS_RUNTIME_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Selected cooperative same-user macOS process profile. These pointers are local
 * identities, never serializable credentials. The trusted host owns approvals.
 * Calls belong to the creating thread. Cross-thread start/read are refused;
 * cross-thread stop/destroy do nothing. Marshal cleanup to the owner thread. */
typedef struct one01_rss_runtime one01_rss_runtime;
/* The fields are diagnostic only. A struct copy fails pointer-identity checks. */
typedef struct one01_rss_handle { const one01_rss_runtime *owner; uint64_t epoch; unsigned generation; } one01_rss_handle;
typedef enum { ONE01_RSS_REGISTER = 1, ONE01_RSS_READ = 2 } one01_rss_action;
typedef enum { ONE01_RSS_OK = 0, ONE01_RSS_DENIED = 1, ONE01_RSS_STALE = 2,
  ONE01_RSS_BUSY = 3, ONE01_RSS_LIMIT = 4, ONE01_RSS_UNAVAILABLE = 5 } one01_rss_status;
typedef struct { uint64_t epoch; uint32_t sequence; uint64_t captured_at_ns; uint64_t rss_bytes; } one01_rss_sample;

/* Return one current deadline in the native CLOCK_MONOTONIC domain. A callback
 * may call stop/destroy; destruction waits for the current call to unwind.
 * Nested start/read return BUSY. The runtime rechecks after every callout. */
typedef int (*one01_rss_approve)(void *context, one01_rss_action action, uint64_t epoch,
  uint64_t now_ns, uint64_t *deadline_ns);
typedef int (*one01_rss_current)(void *context, uint64_t epoch);

one01_rss_runtime *one01_rss_create(one01_rss_approve approve, one01_rss_current current, void *context);
one01_rss_status one01_rss_start(one01_rss_runtime *runtime, uint64_t epoch, const one01_rss_handle **handle);
one01_rss_status one01_rss_read(one01_rss_runtime *runtime, const one01_rss_handle *handle,
  one01_rss_sample *output);
void one01_rss_stop(one01_rss_runtime *runtime);
void one01_rss_destroy(one01_rss_runtime *runtime);

#ifdef __cplusplus
}
#endif
#endif
