#include "one01_pointer_wire.h"
#include <errno.h>
#include <fenv.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int unhex(const char *input, uint8_t *out, size_t capacity, size_t *length) {
    size_t n = strlen(input);
    if (n % 2 || n / 2 > capacity) return 0;
    for (size_t i = 0; i < n / 2; ++i) {
        unsigned value = 0;
        for (size_t j = 0; j < 2; ++j) {
            char c = input[i * 2 + j];
            if (c >= '0' && c <= '9') value = value * 16 + (unsigned)(c - '0');
            else if (c >= 'a' && c <= 'f') value = value * 16 + (unsigned)(c - 'a' + 10);
            else return 0;
        }
        out[i] = (uint8_t)value;
    }
    *length = n / 2; return 1;
}
static int integer(const char *input, uint64_t max, uint64_t *out) {
    if (!*input) return 0;
    for (const char *p = input; *p; ++p) if (*p < '0' || *p > '9') return 0;
    char *end; errno = 0; unsigned long long value = strtoull(input, &end, 10);
    if (errno || *end || value > max) return 0;
    *out = (uint64_t)value; return 1;
}
static int rounding_probe(void) {
    const int modes[] = { FE_TONEAREST, FE_UPWARD, FE_DOWNWARD, FE_TOWARDZERO };
    int saved = fegetround();
    one01_pointer_sample sample = {0}; sample.slot = 1; sample.sequence = 1; sample.x = 0.5000000001; sample.y = 0.5;
    uint8_t expected[48], actual[48];
    if (fesetround(FE_TONEAREST) || one01_pointer_encode(&sample, expected, sizeof expected) != ONE01_POINTER_OK) return 0;
    if (expected[36] != 0x3f || expected[37] || expected[38] || expected[39]) return 0;
    for (size_t i = 0; i < sizeof modes / sizeof modes[0]; ++i) {
        if (fesetround(modes[i])) return 0;
        int exceptions = fetestexcept(FE_ALL_EXCEPT);
        if (one01_pointer_encode(&sample, actual, sizeof actual) != ONE01_POINTER_OK ||
            memcmp(actual, expected, sizeof actual) || fegetround() != modes[i] || fetestexcept(FE_ALL_EXCEPT) != exceptions) return 0;
    }
    return fesetround(saved) == 0;
}
int main(void) {
    if (!rounding_probe()) return 5;
    char line[4098]; unsigned count = 0;
    while (fgets(line, sizeof line, stdin)) {
        if (++count > 128 || (!strchr(line, '\n') && !feof(stdin))) return 2;
        char *fields[8]; size_t n = 0;
        for (char *p = strtok(line, " \r\n"); p && n < 8; p = strtok(NULL, " \r\n")) fields[n++] = p;
        uint8_t output[48], prior[48]; memset(output, 0xa5, sizeof output); memcpy(prior, output, sizeof prior);
        one01_pointer_sample sample; one01_pointer_status status = ONE01_POINTER_INVALID;
        if (n == 7 && !strcmp(fields[0], "E")) {
            size_t length; uint64_t slot, sequence; char *end[3];
            if (unhex(fields[1], sample.epoch, 16, &length) && length == 16 && integer(fields[2], UINT16_MAX, &slot) && integer(fields[3], UINT32_MAX, &sequence)) {
                sample.slot = (uint16_t)slot; sample.sequence = (uint32_t)sequence;
                sample.captured_at = strtod(fields[4], &end[0]); sample.x = strtod(fields[5], &end[1]); sample.y = strtod(fields[6], &end[2]);
                if (!*end[0] && !*end[1] && !*end[2]) status = one01_pointer_encode(&sample, output, sizeof output);
            }
        } else if (n == 3 && !strcmp(fields[0], "D")) {
            uint8_t input[1024]; size_t length;
            one01_pointer_sample before; memset(&sample, 0xa5, sizeof sample); memcpy(&before, &sample, sizeof before);
            one01_pointer_lane lane = !strcmp(fields[1], "disposable") ? ONE01_POINTER_DISPOSABLE : ONE01_POINTER_RELIABLE;
            if (unhex(fields[2], input, sizeof input, &length)) {
                status = one01_pointer_decode(input, length, lane, &sample);
                if (status != ONE01_POINTER_OK && memcmp(&before, &sample, sizeof sample)) return 3;
                if (status == ONE01_POINTER_OK) status = one01_pointer_encode(&sample, output, sizeof output);
            }
        }
        if (status != ONE01_POINTER_OK) { if (memcmp(prior, output, sizeof output)) return 4; puts("null"); }
        else { fputs("{\"hex\":\"", stdout); for (size_t i = 0; i < sizeof output; ++i) printf("%02x", output[i]); puts("\"}"); }
    }
    return ferror(stdin) ? 2 : 0;
}
