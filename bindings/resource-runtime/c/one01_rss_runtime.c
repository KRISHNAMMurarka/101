#include "one01_rss_runtime.h"

#include <mach/mach.h>
#include <pthread.h>
#include <stdlib.h>
#include <time.h>

enum { MAX_GENERATIONS = 2, MAX_READS = 32 };
struct one01_rss_runtime {
  one01_rss_approve approve; one01_rss_current current; void *context;
  struct one01_rss_handle handles[MAX_GENERATIONS];
  const struct one01_rss_handle *active;
  uint64_t registration_deadline; uint32_t sequence;
  unsigned generations; unsigned revision;
  pthread_t owner_thread;
  int in_call; int destroy_pending;
};

static int native_time(uint64_t *output) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0 || time.tv_sec < 0 || time.tv_nsec < 0) return 0;
  *output = (uint64_t)time.tv_sec * UINT64_C(1000000000) + (uint64_t)time.tv_nsec;
  return 1;
}

one01_rss_runtime *one01_rss_create(one01_rss_approve approve, one01_rss_current current, void *context) {
  if (!approve || !current) return NULL;
  one01_rss_runtime *runtime = calloc(1, sizeof(*runtime));
  if (!runtime) return NULL;
  runtime->approve = approve; runtime->current = current; runtime->context = context;
  runtime->owner_thread = pthread_self();
  return runtime;
}

static one01_rss_status start_owned(one01_rss_runtime *runtime, uint64_t epoch, const one01_rss_handle **handle) {
  if (!runtime || !handle || epoch == 0) return ONE01_RSS_DENIED;
  if (runtime->active) return ONE01_RSS_BUSY;
  if (runtime->generations >= MAX_GENERATIONS) return ONE01_RSS_LIMIT;
  uint64_t now, deadline = 0;
  if (!native_time(&now)) return ONE01_RSS_UNAVAILABLE;
  unsigned revision = runtime->revision;
  if (!runtime->approve(runtime->context, ONE01_RSS_REGISTER, epoch, now, &deadline) ||
      revision != runtime->revision || runtime->active || deadline <= now ||
      deadline - now > UINT64_C(10000000000)) return ONE01_RSS_DENIED;
  if (!native_time(&now) || now >= deadline) return ONE01_RSS_DENIED;
  if (!runtime->current(runtime->context, epoch) || revision != runtime->revision ||
      runtime->active || runtime->generations >= MAX_GENERATIONS ||
      !native_time(&now) || now >= deadline) return ONE01_RSS_DENIED;
  struct one01_rss_handle *issued = &runtime->handles[runtime->generations++];
  issued->owner = runtime; issued->epoch = epoch; issued->generation = runtime->generations;
  runtime->active = issued; runtime->registration_deadline = deadline; runtime->sequence = 0;
  *handle = issued;
  return ONE01_RSS_OK;
}

static one01_rss_status read_owned(one01_rss_runtime *runtime, const one01_rss_handle *handle,
    one01_rss_sample *output) {
  if (!runtime || !handle || !output || handle != runtime->active || handle->owner != runtime)
    return ONE01_RSS_STALE;
  if (runtime->sequence >= MAX_READS) return ONE01_RSS_LIMIT;
  uint64_t now, deadline = 0;
  if (!native_time(&now)) return ONE01_RSS_UNAVAILABLE;
  if (now >= runtime->registration_deadline || !runtime->current(runtime->context, handle->epoch) ||
      !native_time(&now) || now >= runtime->registration_deadline)
    return ONE01_RSS_DENIED;
  unsigned revision = runtime->revision;
  if (!runtime->approve(runtime->context, ONE01_RSS_READ, handle->epoch, now, &deadline) ||
      revision != runtime->revision || handle != runtime->active || deadline <= now ||
      deadline - now > UINT64_C(1000000000)) return ONE01_RSS_DENIED;
  if (!native_time(&now) || now >= deadline || now >= runtime->registration_deadline ||
      revision != runtime->revision || handle != runtime->active) return ONE01_RSS_DENIED;
  if (!runtime->current(runtime->context, handle->epoch) || !native_time(&now) ||
      now >= deadline || now >= runtime->registration_deadline ||
      revision != runtime->revision || handle != runtime->active) return ONE01_RSS_DENIED;
  mach_task_basic_info_data_t info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) != KERN_SUCCESS ||
      count != MACH_TASK_BASIC_INFO_COUNT || info.resident_size == 0) return ONE01_RSS_UNAVAILABLE;
  if (!native_time(&now) || now >= deadline || now >= runtime->registration_deadline ||
      revision != runtime->revision || handle != runtime->active ||
      !runtime->current(runtime->context, handle->epoch)) return ONE01_RSS_STALE;
  const uint64_t captured_at = now;
  if (!native_time(&now) || now >= deadline || now >= runtime->registration_deadline ||
      revision != runtime->revision || handle != runtime->active) return ONE01_RSS_STALE;
  one01_rss_sample sample = { handle->epoch, runtime->sequence + 1, captured_at, info.resident_size };
  runtime->sequence++; *output = sample;
  return ONE01_RSS_OK;
}

static one01_rss_status settle(one01_rss_runtime *runtime, one01_rss_status status) {
  runtime->in_call = 0;
  if (runtime->destroy_pending) { free(runtime); return ONE01_RSS_STALE; }
  return status;
}

one01_rss_status one01_rss_start(one01_rss_runtime *runtime, uint64_t epoch, const one01_rss_handle **handle) {
  if (handle) *handle = NULL;
  if (!runtime || !handle || !pthread_equal(runtime->owner_thread, pthread_self())) return ONE01_RSS_DENIED;
  if (runtime->in_call) return ONE01_RSS_BUSY;
  runtime->in_call = 1;
  const one01_rss_status status = start_owned(runtime, epoch, handle);
  if (runtime->destroy_pending) *handle = NULL;
  return settle(runtime, status);
}

one01_rss_status one01_rss_read(one01_rss_runtime *runtime, const one01_rss_handle *handle,
    one01_rss_sample *output) {
  if (!runtime || !pthread_equal(runtime->owner_thread, pthread_self())) return ONE01_RSS_STALE;
  if (runtime->in_call) return ONE01_RSS_BUSY;
  runtime->in_call = 1;
  return settle(runtime, read_owned(runtime, handle, output));
}

void one01_rss_stop(one01_rss_runtime *runtime) {
  if (!runtime || !pthread_equal(runtime->owner_thread, pthread_self())) return;
  runtime->revision++; runtime->active = NULL; runtime->registration_deadline = 0;
}

void one01_rss_destroy(one01_rss_runtime *runtime) {
  if (!runtime || !pthread_equal(runtime->owner_thread, pthread_self())) return;
  one01_rss_stop(runtime);
  if (runtime->in_call) { runtime->destroy_pending = 1; return; }
  free(runtime);
}
