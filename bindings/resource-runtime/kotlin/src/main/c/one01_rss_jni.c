#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "one01_rss_runtime.h"

enum { MAX_RUNTIMES = 8, MAX_HANDLES = 2 };
typedef struct {
  uint64_t token;
  one01_rss_runtime *runtime;
  jobject owner;
  jmethodID approve_method, current_method;
  JNIEnv *env;
  const one01_rss_handle *handles[MAX_HANDLES];
  uint64_t handle_tokens[MAX_HANDLES];
  unsigned handle_count;
  unsigned in_call;
  int destroy_pending;
  int claimed;
  pthread_t owner_thread;
} slot;
static slot slots[MAX_RUNTIMES];
static pthread_mutex_t slots_lock = PTHREAD_MUTEX_INITIALIZER;

static uint64_t fresh_token(void) {
  uint64_t value = 0;
  do { arc4random_buf(&value, sizeof(value)); value &= UINT64_MAX >> 1; } while (value == 0);
  return value;
}
/* Called only while slots_lock is held. A claim stays occupied until native
 * destruction and the Java global reference have both settled. */
static slot *find_slot_unlocked(jlong token) {
  if (token <= 0) return NULL;
  for (unsigned index = 0; index < MAX_RUNTIMES; index++)
    if (slots[index].claimed && slots[index].runtime && slots[index].token == (uint64_t)token) return &slots[index];
  return NULL;
}
static slot *pin_slot(jlong token) {
  pthread_mutex_lock(&slots_lock);
  slot *s = find_slot_unlocked(token);
  if (s && (!pthread_equal(s->owner_thread, pthread_self()) || s->destroy_pending)) s = NULL;
  if (s) s->in_call++;
  pthread_mutex_unlock(&slots_lock);
  return s;
}
static jlongArray row(JNIEnv *env, const jlong *values, jsize count) {
  jlongArray output = (*env)->NewLongArray(env, count);
  if (output) (*env)->SetLongArrayRegion(env, output, 0, count, values);
  return output;
}
static void release_slot(JNIEnv *env, slot *s) {
  if (s->runtime) one01_rss_destroy(s->runtime);
  if (s->owner) (*env)->DeleteGlobalRef(env, s->owner);
  pthread_mutex_lock(&slots_lock);
  memset(s, 0, sizeof(*s));
  pthread_mutex_unlock(&slots_lock);
}
static void unpin_slot(JNIEnv *env, slot *s) {
  pthread_mutex_lock(&slots_lock);
  s->in_call--;
  int release = s->destroy_pending && s->in_call == 0;
  pthread_mutex_unlock(&slots_lock);
  if (release) release_slot(env, s);
}
static int approved(void *context, one01_rss_action action, uint64_t epoch, uint64_t now_ns, uint64_t *deadline_ns) {
  slot *s = context; JNIEnv *env = s->env;
  if (!env) return 0;
  jobject result = (*env)->CallObjectMethod(env, s->owner, s->approve_method, (jint)action, (jlong)epoch, (jlong)now_ns);
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return 0; }
  if (!result) return 0;
  jclass long_class = (*env)->GetObjectClass(env, result);
  jmethodID long_value = long_class ? (*env)->GetMethodID(env, long_class, "longValue", "()J") : NULL;
  jlong deadline = long_value ? (*env)->CallLongMethod(env, result, long_value) : 0;
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); deadline = 0; }
  if (long_class) (*env)->DeleteLocalRef(env, long_class);
  (*env)->DeleteLocalRef(env, result);
  if (deadline <= 0) return 0;
  *deadline_ns = (uint64_t)deadline; return 1;
}
static int current(void *context, uint64_t epoch) {
  slot *s = context; JNIEnv *env = s->env;
  if (!env) return 0;
  jboolean result = (*env)->CallBooleanMethod(env, s->owner, s->current_method, (jlong)epoch);
  if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return 0; }
  return result == JNI_TRUE;
}

JNIEXPORT jlong JNICALL Java_one01_resourcerss_ResourceRssRuntime_nativeCreate(JNIEnv *env, jobject self) {
  slot *s = NULL;
  pthread_mutex_lock(&slots_lock);
  for (unsigned index = 0; index < MAX_RUNTIMES; index++) if (!slots[index].claimed) {
    s = &slots[index]; s->claimed = 1; s->owner_thread = pthread_self(); break;
  }
  pthread_mutex_unlock(&slots_lock);
  if (!s) return 0;
  jclass klass = (*env)->GetObjectClass(env, self);
  if (!klass) { release_slot(env, s); return 0; }
  jmethodID approve_method = (*env)->GetMethodID(env, klass, "approveNative", "(IJJ)Ljava/lang/Long;");
  jmethodID current_method = (*env)->GetMethodID(env, klass, "currentNative", "(J)Z");
  (*env)->DeleteLocalRef(env, klass);
  if (!approve_method || !current_method || (*env)->ExceptionCheck(env)) {
    (*env)->ExceptionClear(env); release_slot(env, s); return 0;
  }
  s->owner = (*env)->NewGlobalRef(env, self);
  if (!s->owner) { release_slot(env, s); return 0; }
  s->approve_method = approve_method; s->current_method = current_method; s->env = env;
  s->runtime = one01_rss_create(approved, current, s);
  if (!s->runtime) { release_slot(env, s); return 0; }
  pthread_mutex_lock(&slots_lock);
  uint64_t token;
  do { token = fresh_token(); } while (find_slot_unlocked((jlong)token));
  s->token = token;
  pthread_mutex_unlock(&slots_lock);
  return (jlong)token;
}

JNIEXPORT jlongArray JNICALL Java_one01_resourcerss_ResourceRssRuntime_nativeStart(JNIEnv *env, jobject self,
    jlong runtime_token, jlong epoch) {
  (void)self; slot *s = pin_slot(runtime_token);
  jlong result[2] = { ONE01_RSS_STALE, 0 };
  if (!s) return row(env, result, 2);
  s->env = env;
  const one01_rss_handle *handle = NULL;
  result[0] = one01_rss_start(s->runtime, epoch > 0 ? (uint64_t)epoch : 0, &handle);
  if (s->destroy_pending) result[0] = ONE01_RSS_STALE;
  if (result[0] == ONE01_RSS_OK && handle && s->handle_count < MAX_HANDLES) {
    unsigned index = s->handle_count++;
    s->handles[index] = handle;
    uint64_t token;
    do { token = fresh_token(); } while (token == s->token ||
      (index > 0 && token == s->handle_tokens[0]));
    s->handle_tokens[index] = token; result[1] = (jlong)token;
  }
  unpin_slot(env, s);
  return row(env, result, 2);
}

JNIEXPORT jlongArray JNICALL Java_one01_resourcerss_ResourceRssRuntime_nativeRead(JNIEnv *env, jobject self,
    jlong runtime_token, jlong handle_token) {
  (void)self; slot *s = pin_slot(runtime_token);
  jlong result[5] = { ONE01_RSS_STALE, 0, 0, 0, 0 };
  if (!s) return row(env, result, 5);
  if (handle_token <= 0) { unpin_slot(env, s); return row(env, result, 5); }
  const one01_rss_handle *handle = NULL;
  for (unsigned index = 0; index < s->handle_count; index++)
    if (s->handle_tokens[index] == (uint64_t)handle_token) { handle = s->handles[index]; break; }
  if (!handle) { unpin_slot(env, s); return row(env, result, 5); }
  s->env = env;
  one01_rss_sample sample = {0};
  result[0] = one01_rss_read(s->runtime, handle, &sample);
  if (s->destroy_pending) result[0] = ONE01_RSS_STALE;
  if (result[0] == ONE01_RSS_OK) {
    result[1] = (jlong)sample.epoch; result[2] = sample.sequence;
    result[3] = (jlong)sample.captured_at_ns; result[4] = (jlong)sample.rss_bytes;
  }
  unpin_slot(env, s);
  return row(env, result, 5);
}

JNIEXPORT void JNICALL Java_one01_resourcerss_ResourceRssRuntime_nativeStop(JNIEnv *env, jobject self, jlong token) {
  (void)self; slot *s = pin_slot(token); if (!s) return;
  one01_rss_stop(s->runtime); unpin_slot(env, s);
}
JNIEXPORT void JNICALL Java_one01_resourcerss_ResourceRssRuntime_nativeDestroy(JNIEnv *env, jobject self, jlong token) {
  (void)self; slot *s = pin_slot(token); if (!s) return;
  one01_rss_stop(s->runtime);
  pthread_mutex_lock(&slots_lock);
  s->destroy_pending = 1;
  pthread_mutex_unlock(&slots_lock);
  unpin_slot(env, s);
}
