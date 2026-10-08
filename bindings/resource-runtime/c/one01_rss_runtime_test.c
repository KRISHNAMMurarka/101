#include "one01_rss_runtime.h"

#include <assert.h>
#include <stdint.h>
#include <pthread.h>
#include <stdio.h>
#include <time.h>

typedef struct { int register_allowed; int read_allowed; int current; int stop_in_approval; int expired_approval; int delay_approval;
  one01_rss_runtime *runtime; unsigned calls; int nested_current; int nested_read;
  const one01_rss_handle *handle; } fixture;
static int destroy_in_approval;
static int approve(void *context, one01_rss_action action, uint64_t epoch,
    uint64_t now_ns, uint64_t *deadline_ns) {
  fixture *f = context; f->calls++;
  if (destroy_in_approval) { destroy_in_approval = 0; one01_rss_destroy(f->runtime); }
  if (f->nested_read && action == ONE01_RSS_READ) {
    f->nested_read = 0;
    one01_rss_sample nested = {0};
    assert(one01_rss_read(f->runtime, f->handle, &nested) == ONE01_RSS_BUSY);
  }
  if (f->stop_in_approval) one01_rss_stop(f->runtime);
  if (epoch == 0 || !(action == ONE01_RSS_REGISTER ? f->register_allowed : f->read_allowed)) return 0;
  *deadline_ns = now_ns + (f->expired_approval ? 0 : f->delay_approval ? UINT64_C(1000000) :
    action == ONE01_RSS_REGISTER ? UINT64_C(10000000000) : UINT64_C(1000000000));
  if (f->delay_approval) { const struct timespec pause = {0, 3000000}; nanosleep(&pause, NULL); }
  return 1;
}
static int current(void *context, uint64_t epoch) {
  fixture *f = context;
  if (f->nested_current) {
    f->nested_current = 0;
    const one01_rss_handle *nested = NULL;
    assert(one01_rss_start(f->runtime, epoch + 1, &nested) == ONE01_RSS_BUSY && nested == NULL);
  }
  return f->current && epoch > 0;
}
static void *other_thread(void *context) {
  fixture *f = context;
  const one01_rss_handle *handle = NULL; one01_rss_sample sample = {0};
  assert(one01_rss_start(f->runtime, 99, &handle) == ONE01_RSS_DENIED && !handle);
  assert(one01_rss_read(f->runtime, f->handle, &sample) == ONE01_RSS_STALE);
  one01_rss_stop(f->runtime); one01_rss_destroy(f->runtime);
  return NULL;
}
int main(void) {
  fixture f = {0}; f.runtime = one01_rss_create(approve, current, &f);
  assert(f.runtime); const one01_rss_handle *first = NULL, *second = NULL;
  one01_rss_sample sample = {0};
  assert(one01_rss_start(f.runtime, 11, &first) == ONE01_RSS_DENIED && first == NULL);
  f.register_allowed = 1; f.current = 1;
  f.expired_approval = 1;
  assert(one01_rss_start(f.runtime, 11, &first) == ONE01_RSS_DENIED && first == NULL);
  f.expired_approval = 0;
  f.stop_in_approval = 1;
  assert(one01_rss_start(f.runtime, 11, &first) == ONE01_RSS_DENIED && first == NULL);
  f.stop_in_approval = 0;
  assert(one01_rss_start(f.runtime, 11, &first) == ONE01_RSS_OK && first);
  assert(one01_rss_start(f.runtime, 12, &second) == ONE01_RSS_BUSY && second == NULL);
  one01_rss_handle copied = *first;
  assert(one01_rss_read(f.runtime, &copied, &sample) == ONE01_RSS_STALE);
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_DENIED && sample.rss_bytes == 0);
  f.read_allowed = 1;
  f.expired_approval = 1;
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_DENIED && sample.rss_bytes == 0);
  f.expired_approval = 0;
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_OK);
  assert(sample.epoch == 11 && sample.sequence == 1 && sample.rss_bytes > 0 && sample.captured_at_ns > 0);
  f.delay_approval = 1;
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_DENIED && sample.sequence == 1);
  f.delay_approval = 0;
  f.current = 0; assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_DENIED);
  f.current = 1; f.stop_in_approval = 1;
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_DENIED);
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_STALE);
  f.stop_in_approval = 0;
  assert(one01_rss_start(f.runtime, 12, &second) == ONE01_RSS_OK && second && second != first);
  assert(one01_rss_read(f.runtime, first, &sample) == ONE01_RSS_STALE);
  assert(one01_rss_read(f.runtime, second, &sample) == ONE01_RSS_OK && sample.epoch == 12 && sample.sequence == 1);
  for (unsigned index = 2; index <= 32; index++) {
    assert(one01_rss_read(f.runtime, second, &sample) == ONE01_RSS_OK && sample.sequence == index);
  }
  assert(one01_rss_read(f.runtime, second, &sample) == ONE01_RSS_LIMIT);
  one01_rss_stop(f.runtime);
  assert(one01_rss_read(f.runtime, second, &sample) == ONE01_RSS_STALE);
  assert(one01_rss_start(f.runtime, 13, &first) == ONE01_RSS_LIMIT);
  one01_rss_destroy(f.runtime);
  fixture reentrant = {0}; reentrant.register_allowed = 1; reentrant.read_allowed = 1;
  reentrant.current = 1; reentrant.nested_current = 1;
  reentrant.runtime = one01_rss_create(approve, current, &reentrant);
  assert(one01_rss_start(reentrant.runtime, 31, &reentrant.handle) == ONE01_RSS_OK);
  reentrant.nested_read = 1;
  assert(one01_rss_read(reentrant.runtime, reentrant.handle, &sample) == ONE01_RSS_OK && sample.sequence == 1);
  pthread_t thread;
  assert(pthread_create(&thread, NULL, other_thread, &reentrant) == 0);
  assert(pthread_join(thread, NULL) == 0);
  assert(one01_rss_read(reentrant.runtime, reentrant.handle, &sample) == ONE01_RSS_OK && sample.sequence == 2);
  one01_rss_destroy(reentrant.runtime);
  fixture destroyed = {0}; destroyed.register_allowed = 1; destroyed.current = 1;
  destroyed.runtime = one01_rss_create(approve, current, &destroyed);
  destroy_in_approval = 1;
  assert(one01_rss_start(destroyed.runtime, 41, &destroyed.handle) == ONE01_RSS_STALE && !destroyed.handle);
  puts("native-c-groups:denial,identity,read,stop,replacement,limit,reentrancy-thread-destroy");
  return 0;
}
