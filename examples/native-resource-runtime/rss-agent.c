#include "one01_rss_runtime.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Fixed private-stdio caller. Only its own resident bytes can be read. The
 * cooperative host owns the pipe and issues separate START/READ approvals. */
typedef struct {
  one01_rss_action pending; uint64_t epoch; uint64_t deadline_ns;
  char token[33]; int active;
} host_port;

static int approve(void *context, one01_rss_action action, uint64_t epoch,
    uint64_t now_ns, uint64_t *deadline_ns) {
  host_port *port = context;
  if (port->pending != action || port->epoch != epoch || port->deadline_ns <= now_ns ||
      port->deadline_ns - now_ns > (action == ONE01_RSS_REGISTER ? UINT64_C(10000000000) : UINT64_C(1000000000))) return 0;
  port->pending = 0; *deadline_ns = port->deadline_ns;
  return 1;
}
static int current(void *context, uint64_t epoch) {
  host_port *port = context;
  return port->active && port->epoch == epoch;
}
static int decimal(const char *text, uint64_t *out) {
  if (!text || !*text) return 0;
  uint64_t value = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p < '0' || *p > '9' || value > (UINT64_MAX - (*p - '0')) / 10) return 0;
    value = value * 10 + (*p - '0');
  }
  *out = value; return value != 0;
}
static int token(const char *text) {
  if (!text || strlen(text) != 32) return 0;
  for (const char *p = text; *p; p++) if (!(*p >= '0' && *p <= '9') && !(*p >= 'a' && *p <= 'f')) return 0;
  return 1;
}
static int frame(char *line, char **fields, size_t wanted) {
  size_t length = strlen(line);
  if (!length || line[length - 1] != '\n' || length > 256) return 0;
  line[length - 1] = 0;
  if (length > 1 && line[length - 2] == '\r') return 0;
  size_t count = 0; char *save = NULL;
  for (char *part = strtok_r(line, " ", &save); part; part = strtok_r(NULL, " ", &save)) {
    if (count >= wanted) return 0;
    fields[count++] = part;
  }
  return count == wanted;
}

int main(void) {
  host_port port = {0};
  one01_rss_runtime *runtime = one01_rss_create(approve, current, &port);
  if (!runtime) return 2;
  struct timespec anchor;
  if (clock_gettime(CLOCK_MONOTONIC, &anchor) != 0 || anchor.tv_sec < 0 || anchor.tv_nsec < 0) {
    one01_rss_destroy(runtime); return 2;
  }
  uint64_t anchor_ns = (uint64_t)anchor.tv_sec * UINT64_C(1000000000) + (uint64_t)anchor.tv_nsec;
  if (printf("HELLO 1 %" PRIu64 "\n", anchor_ns) < 0 || fflush(stdout) != 0) {
    one01_rss_destroy(runtime); return 2;
  }
  const one01_rss_handle *handle = NULL;
  char line[258]; unsigned commands = 0; int result = 0;
  while (fgets(line, sizeof line, stdin) && ++commands <= 36) {
    char *fields[5];
    if (strcmp(line, "STOP 1\n") == 0) { one01_rss_stop(runtime); port.active = 0;
      if (puts("STOPPED 1") == EOF || fflush(stdout) != 0) result = 2; break; }
    if (!frame(line, fields, 5) || strcmp(fields[1], "1") != 0 ||
        !token(fields[4]) || strlen(fields[4]) >= sizeof port.token) { result = 2; break; }
    uint64_t epoch, deadline_ns;
    if (!decimal(fields[2], &epoch) || !decimal(fields[3], &deadline_ns)) { result = 2; break; }
    if (strcmp(fields[0], "START") == 0 && !port.active) {
      port.pending = ONE01_RSS_REGISTER; port.epoch = epoch; port.deadline_ns = deadline_ns;
      memcpy(port.token, fields[4], 33); port.active = 1;
      if (one01_rss_start(runtime, epoch, &handle) == ONE01_RSS_OK) {
        if (printf("READY 1 %" PRIu64 "\n", epoch) < 0) { result = 2; break; }
      } else { port.active = 0; if (puts("DENIED 1") == EOF) { result = 2; break; } }
    } else if (strcmp(fields[0], "READ") == 0 && port.active &&
        port.epoch == epoch && strcmp(port.token, fields[4]) == 0) {
      port.pending = ONE01_RSS_READ; port.deadline_ns = deadline_ns;
      one01_rss_sample sample;
      if (one01_rss_read(runtime, handle, &sample) == ONE01_RSS_OK) {
        if (printf("SAMPLE 1 %" PRIu64 " %" PRIu32 " %" PRIu64 " %" PRIu64 "\n",
            sample.epoch, sample.sequence, sample.captured_at_ns, sample.rss_bytes) < 0) { result = 2; break; }
      } else if (puts("DENIED 1") == EOF) { result = 2; break; }
    } else if (puts("DENIED 1") == EOF) { result = 2; break; }
    if (fflush(stdout) != 0) { result = 2; break; }
  }
  one01_rss_destroy(runtime);
  return result;
}
