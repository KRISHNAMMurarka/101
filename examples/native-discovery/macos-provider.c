/* Owned host adapter for Apple's installed DNS-SD API. All native operations
 * are LocalOnly; no address query, arbitrary URL, LAN/P2P/AWDL or fallback. */
#include <dns_sd.h>
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>
#define MAX_RESOLVERS 8
#define MAX_BYTES 16384
static volatile sig_atomic_t quitting;
static DNSServiceRef primary;
static const char *expected_type;
static int failed;
static size_t output_bytes;
static uint64_t window_at;
static unsigned events;
typedef struct { DNSServiceRef ref; char name[64]; int done; } Resolver;
static Resolver resolvers[MAX_RESOLVERS];
static void signal_stop(int signo) { (void)signo; quitting = 1; }
static uint64_t now_ms(void) { struct timespec at; if (clock_gettime(CLOCK_MONOTONIC, &at) != 0) return 0;
  return (uint64_t)at.tv_sec * 1000 + (uint64_t)at.tv_nsec / 1000000; }
static int budget(void) { uint64_t at = now_ms(); if (at - window_at >= 1000) { window_at = at; events = 0; }
  if (++events > 64 || output_bytes >= MAX_BYTES) { failed = 1; quitting = 1; return 0; } return 1; }
static int emit(const char *line) { size_t length = strlen(line); if (!budget() || length + output_bytes > MAX_BYTES) { failed = 1; quitting = 1; return 0; }
  output_bytes += length; if (fwrite(line, 1, length, stdout) != length || fflush(stdout) != 0) { failed = 1; quitting = 1; return 0; } return 1; }
static int quoted(const char *source, char *destination, size_t capacity) {
  size_t out = 0, length = strnlen(source, 1025); if (length > 1024 || capacity < 3) return 0;
  destination[out++] = '"';
  for (size_t i = 0; i < length; i++) { unsigned char c = (unsigned char)source[i];
    if (c == '"' || c == '\\') { if (out + 2 >= capacity) return 0; destination[out++] = '\\'; destination[out++] = (char)c; }
    else if (c < 32 || c == 127) { if (out + 6 >= capacity) return 0; int n = snprintf(destination + out, capacity - out, "\\u%04x", c); if (n != 6) return 0; out += 6; }
    else { if (out + 1 >= capacity) return 0; destination[out++] = (char)c; }
  }
  if (out + 2 > capacity) return 0; destination[out++] = '"'; destination[out] = 0; return 1;
}
static int valid_type(const char *type) { size_t length = strnlen(type, 23); if (length < 7 || length > 21 || type[0] != '_' || strcmp(type + length - 5, "._tcp") != 0) return 0;
  size_t part = length - 6; if (part < 1 || part > 15) return 0;
  for (size_t i = 1; i <= part; i++) { char c = type[i]; if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c != '-') return 0; } return 1; }
static int same_type(const char *type) { char canonical[24]; int n = snprintf(canonical, sizeof canonical, "%s.", expected_type);
  return n > 0 && (strcmp(type, expected_type) == 0 || strcmp(type, canonical) == 0); }
static void resolved(DNSServiceRef ref, DNSServiceFlags flags, uint32_t index, DNSServiceErrorType error,
  const char *fullname, const char *target, uint16_t port, uint16_t txt_length, const unsigned char *txt, void *context) {
  (void)flags; (void)fullname; Resolver *slot = context; if (slot->ref != ref || slot->done) return; slot->done = 1;
  if (error != kDNSServiceErr_NoError || index != kDNSServiceInterfaceIndexLocalOnly || txt_length > 512) { failed = 1; quitting = 1; return; }
  char qname[400], qtarget[800], qtype[100], hex[1025], line[1600];
  if (!quoted(slot->name, qname, sizeof qname) || !quoted(target, qtarget, sizeof qtarget) || !quoted(expected_type, qtype, sizeof qtype)) { failed = 1; quitting = 1; return; }
  for (unsigned i = 0; i < txt_length; i++) snprintf(hex + i * 2, 3, "%02x", txt[i]); hex[txt_length * 2] = 0;
  int count = snprintf(line, sizeof line, "{\"version\":1,\"type\":\"resolved\",\"interfaceIndex\":%u,\"name\":%s,\"serviceType\":%s,\"domain\":\"local.\",\"target\":%s,\"port\":%u,\"txtHex\":\"%s\"}\n", index, qname, qtype, qtarget, ntohs(port), hex);
  if (count < 0 || (size_t)count >= sizeof line) { failed = 1; quitting = 1; return; } emit(line);
}
static void browse(DNSServiceRef ref, DNSServiceFlags flags, uint32_t index, DNSServiceErrorType error,
  const char *name, const char *type, const char *domain, void *context) {
  (void)ref; (void)context;
  if (error != kDNSServiceErr_NoError) { failed = 1; quitting = 1; return; }
  if (index != kDNSServiceInterfaceIndexLocalOnly || !same_type(type) || strcmp(domain, "local.") != 0 || strnlen(name, 64) > 63) return;
  if (!(flags & kDNSServiceFlagsAdd)) {
    for (unsigned i = 0; i < MAX_RESOLVERS; i++) if (resolvers[i].ref && strcmp(resolvers[i].name, name) == 0) resolvers[i].done = 1;
    char qname[400], qtype[100], line[700]; if (!quoted(name, qname, sizeof qname) || !quoted(expected_type, qtype, sizeof qtype)) return;
    snprintf(line, sizeof line, "{\"version\":1,\"type\":\"removed\",\"interfaceIndex\":%u,\"name\":%s,\"serviceType\":%s,\"domain\":\"local.\"}\n", index, qname, qtype); emit(line); return;
  }
  Resolver *slot = NULL;
  for (unsigned i = 0; i < MAX_RESOLVERS; i++) { if (resolvers[i].ref && !resolvers[i].done && strcmp(resolvers[i].name, name) == 0) return; if (!resolvers[i].ref && !slot) slot = &resolvers[i]; }
  if (!slot) { emit("{\"version\":1,\"type\":\"quota\"}\n"); return; }
  memcpy(slot->name, name, strlen(name) + 1); slot->done = 0;
  /* Independently force LocalOnly, even after checking the browse callback. */
  DNSServiceErrorType result = DNSServiceResolve(&slot->ref, 0, kDNSServiceInterfaceIndexLocalOnly, name, expected_type, "local.", resolved, slot);
  if (result != kDNSServiceErr_NoError) { slot->ref = NULL; failed = 1; quitting = 1; }
}
static void registered(DNSServiceRef ref, DNSServiceFlags flags, DNSServiceErrorType error, const char *name, const char *type, const char *domain, void *context) {
  (void)ref; (void)flags; (void)name; (void)context;
  if (error != kDNSServiceErr_NoError || !same_type(type) || strcmp(domain, "local.") != 0) { failed = 1; quitting = 1; return; }
  emit("{\"version\":1,\"type\":\"ready\"}\n");
}
static int number(const char *text, unsigned long max, unsigned long *value) {
  if (!text[0]) return 0; for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return 0;
  errno = 0; char *end; unsigned long result = strtoul(text, &end, 10); if (errno || *end || !result || result > max) return 0; *value = result; return 1;
}
int main(int argc, char **argv) {
  unsigned long duration, port = 0;
  if (argc < 4 || !valid_type(argv[2])) return 64; expected_type = argv[2];
  int registration = strcmp(argv[1], "register") == 0;
  if (registration) { if (argc != 6 || !argv[3][0] || strnlen(argv[3], 64) > 63 || !number(argv[4], 65535, &port) || !number(argv[5], 30000, &duration)) return 64; }
  else if (strcmp(argv[1], "browse") != 0 || argc != 4 || !number(argv[3], 30000, &duration)) return 64;
  signal(SIGTERM, signal_stop); signal(SIGINT, signal_stop); signal(SIGPIPE, SIG_IGN);
  DNSServiceErrorType result;
  if (registration) { static const unsigned char txt[] = { 9, 'p','r','o','f','i','l','e','=','1' };
    result = DNSServiceRegister(&primary, kDNSServiceFlagsNoAutoRename, kDNSServiceInterfaceIndexLocalOnly,
      argv[3], expected_type, "local.", "localhost.", htons((uint16_t)port), sizeof txt, txt, registered, NULL);
  } else { result = DNSServiceBrowse(&primary, 0, kDNSServiceInterfaceIndexLocalOnly, expected_type, "local.", browse, NULL); }
  if (result != kDNSServiceErr_NoError) return 2;
  if (!registration) emit("{\"version\":1,\"type\":\"ready\"}\n");
  uint64_t started = now_ms(), deadline = started + duration;
  while (!quitting && now_ms() < deadline) {
    fd_set ready; FD_ZERO(&ready); FD_SET(STDIN_FILENO, &ready); int high = STDIN_FILENO;
    DNSServiceRef refs[MAX_RESOLVERS + 1]; refs[0] = primary;
    for (unsigned i = 0; i < MAX_RESOLVERS; i++) { if (resolvers[i].ref && resolvers[i].done) { DNSServiceRefDeallocate(resolvers[i].ref); resolvers[i].ref = NULL; }
      refs[i + 1] = resolvers[i].ref; }
    for (unsigned i = 0; i < MAX_RESOLVERS + 1; i++) if (refs[i]) { int fd = DNSServiceRefSockFD(refs[i]); if (fd < 0 || fd >= FD_SETSIZE) { failed = 1; quitting = 1; break; }
      FD_SET(fd, &ready); if (fd > high) high = fd; }
    if (quitting) break; struct timeval timeout = { 0, 20000 }; int count = select(high + 1, &ready, NULL, NULL, &timeout);
    if (count < 0) { if (errno == EINTR) continue; failed = 1; break; }
    if (FD_ISSET(STDIN_FILENO, &ready)) { char command[32]; ssize_t length = read(STDIN_FILENO, command, sizeof command); (void)length; break; }
    for (unsigned i = 0; i < MAX_RESOLVERS + 1 && !quitting; i++) if (refs[i] && FD_ISSET(DNSServiceRefSockFD(refs[i]), &ready)) {
      if (DNSServiceProcessResult(refs[i]) != kDNSServiceErr_NoError) { failed = 1; quitting = 1; }
    }
  }
  /* One thread processes and deallocates references; no free inside native callbacks. */
  for (unsigned i = 0; i < MAX_RESOLVERS; i++) if (resolvers[i].ref) DNSServiceRefDeallocate(resolvers[i].ref);
  if (primary) DNSServiceRefDeallocate(primary); return failed ? 2 : 0;
}
