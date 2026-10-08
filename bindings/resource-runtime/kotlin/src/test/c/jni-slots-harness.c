#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

/* Include the real bridge so the test sees the actual process-global table. */
#include "../../main/c/one01_rss_jni.c"

static pthread_mutex_t gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static unsigned entered, created;
static int release_workers;

static jclass fake_class(JNIEnv *env, jobject object) {
  (void)env;
  pthread_mutex_lock(&gate);
  entered++;
  pthread_cond_broadcast(&changed);
  while (entered < 2) pthread_cond_wait(&changed, &gate);
  pthread_mutex_unlock(&gate);
  return (jclass)object;
}
static jmethodID fake_method(JNIEnv *env, jclass klass, const char *name, const char *signature) {
  (void)env; (void)klass; (void)name; (void)signature;
  return (jmethodID)(uintptr_t)1;
}
static jobject fake_global(JNIEnv *env, jobject object) { (void)env; return object; }
static void fake_delete(JNIEnv *env, jobject object) { (void)env; (void)object; }
static jboolean fake_exception(JNIEnv *env) { (void)env; return JNI_FALSE; }
static void fake_clear(JNIEnv *env) { (void)env; }

static const struct JNINativeInterface_ functions = {
  .GetObjectClass = fake_class, .GetMethodID = fake_method,
  .NewGlobalRef = fake_global, .DeleteGlobalRef = fake_delete,
  .DeleteLocalRef = fake_delete, .ExceptionCheck = fake_exception,
  .ExceptionClear = fake_clear,
};
typedef struct { jlong token; int owner; } worker;
static void *run(void *argument) {
  worker *item = argument;
  JNIEnv env = &functions;
  item->token = Java_one01_resourcerss_ResourceRssRuntime_nativeCreate(&env, (jobject)(uintptr_t)item->owner);
  pthread_mutex_lock(&gate);
  created++;
  pthread_cond_broadcast(&changed);
  while (!release_workers) pthread_cond_wait(&changed, &gate);
  pthread_mutex_unlock(&gate);
  Java_one01_resourcerss_ResourceRssRuntime_nativeDestroy(&env, (jobject)(uintptr_t)item->owner, item->token);
  return NULL;
}

int main(void) {
  alarm(5);
  pthread_t threads[2];
  worker workers[2] = { { .owner = 1 }, { .owner = 2 } };
  for (unsigned i = 0; i < 2; i++) assert(pthread_create(&threads[i], NULL, run, &workers[i]) == 0);
  pthread_mutex_lock(&gate);
  while (created < 2) pthread_cond_wait(&changed, &gate);
  unsigned occupied = 0, matching = 0;
  for (unsigned i = 0; i < MAX_RUNTIMES; i++) if (slots[i].runtime) {
    occupied++;
    if (slots[i].token == (uint64_t)workers[0].token || slots[i].token == (uint64_t)workers[1].token) matching++;
  }
  release_workers = 1;
  pthread_cond_broadcast(&changed);
  pthread_mutex_unlock(&gate);
  for (unsigned i = 0; i < 2; i++) assert(pthread_join(threads[i], NULL) == 0);
  assert(workers[0].token > 0 && workers[1].token > 0 && workers[0].token != workers[1].token);
  assert(occupied == 2 && matching == 2 && "two constructors must retain distinct owner slots");
  puts("jni-concurrent-slots:pass");
}
