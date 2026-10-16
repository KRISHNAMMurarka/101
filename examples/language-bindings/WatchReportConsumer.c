#include "one01_watch_report.h"

#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LINE_LIMIT 4096u
#define COMMAND_LIMIT 128u
#define INPUT_BYTES_LIMIT 256u
#define OUTPUT_LIMIT 131072u

static int nibble(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static int parse_unsigned(const char *text, unsigned long maximum, unsigned long *output) {
    char *end = NULL; unsigned long value;
    if (text == NULL || *text == '\0' || *text == '-') return 0;
    errno = 0; value = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value > maximum) return 0;
    *output = value; return 1;
}

static int parse_float(const char *text, float *output) {
    char *end = NULL; float value;
    if (text == NULL || *text == '\0') return 0;
    errno = 0; value = strtof(text, &end);
    if (end == text || *end != '\0' || !isfinite(value)) return 0;
    *output = value; return 1;
}

static int parse_hex(const char *text, uint8_t *bytes, size_t *size) {
    size_t length, index;
    if (strcmp(text, "-") == 0) { *size = 0; return 1; }
    length = strlen(text);
    if ((length & 1u) != 0u || length / 2u > INPUT_BYTES_LIMIT) return 0;
    for (index = 0; index < length; index += 2) {
        const int high = nibble(text[index]), low = nibble(text[index + 1]);
        if (high < 0 || low < 0) return 0;
        bytes[index / 2] = (uint8_t)((high << 4) | low);
    }
    *size = length / 2; return 1;
}

static size_t split_tokens(char *line, char *tokens[16]) {
    char *cursor = line; size_t count = 0;
    while (*cursor != '\0') {
        while (*cursor == ' ') cursor++;
        if (*cursor == '\0') break;
        if (count == 16) return 17;
        tokens[count++] = cursor;
        while (*cursor != '\0' && *cursor != ' ') cursor++;
        if (*cursor == ' ') *cursor++ = '\0';
    }
    return count;
}

static int append(char *output, size_t capacity, size_t *used, const char *format, ...) {
    int result; va_list args;
    va_start(args, format); result = vsnprintf(output + *used, capacity - *used, format, args); va_end(args);
    if (result < 0 || (size_t)result >= capacity - *used) return 0;
    *used += (size_t)result; return 1;
}

static int result_json(const One01WatchReport *report, const uint8_t *bytes, size_t size,
                       char *output, size_t capacity, size_t *written) {
    static const char *keys[] = { "orientationReported", "accelerationG", "rotationDegPerSecond" };
    const float *vectors[] = { report->orientation, report->acceleration_g, report->rotation_deg_per_second };
    const size_t lengths[] = { 4, 3, 3 };
    size_t used = 0, index, field;
    if (!append(output, capacity, &used, "{\"hex\":\"")) return 0;
    for (index = 0; index < size; index++) if (!append(output, capacity, &used, "%02x", bytes[index])) return 0;
    if (!append(output, capacity, &used, "\",\"sequence\":%u,\"relayEmissionMs\":%u",
                (unsigned)report->sequence, (unsigned)report->relay_emission_ms)) return 0;
    for (field = 0; field < 3; field++) {
        if (!append(output, capacity, &used, ",\"%s\":[", keys[field])) return 0;
        for (index = 0; index < lengths[field]; index++) {
            if (!append(output, capacity, &used, "%s%.17g", index == 0 ? "" : ",", (double)vectors[field][index])) return 0;
        }
        if (!append(output, capacity, &used, "]")) return 0;
    }
    if (!append(output, capacity, &used, ",\"crownReported\":%.17g,\"tap\":%s}\n",
                (double)report->crown_reported, report->tap ? "true" : "false")) return 0;
    *written = used; return 1;
}

static int command(char *line, char *output, size_t capacity, size_t *written) {
    char *tokens[16]; size_t count;
    uint8_t bytes[INPUT_BYTES_LIMIT]; size_t size = 0;
    One01WatchReport report;
    count = split_tokens(line, tokens);
    if (count > sizeof(tokens) / sizeof(tokens[0])) return 0;
    if (count == 2 && strcmp(tokens[0], "D") == 0) {
        if (!parse_hex(tokens[1], bytes, &size) || !one01_watch_report_decode(bytes, size, &report)) return 0;
        return result_json(&report, bytes, size, output, capacity, written);
    }
    if (count == 15 && strcmp(tokens[0], "E") == 0) {
        unsigned long sequence, emission; float values[11]; size_t index;
        if (!parse_unsigned(tokens[1], UINT16_MAX, &sequence) ||
            !parse_unsigned(tokens[2], UINT32_MAX, &emission) ||
            (strcmp(tokens[14], "0") != 0 && strcmp(tokens[14], "1") != 0)) return 0;
        for (index = 0; index < 11; index++) if (!parse_float(tokens[index + 3], &values[index])) return 0;
        memset(&report, 0, sizeof(report)); report.sequence = (uint16_t)sequence;
        report.relay_emission_ms = (uint32_t)emission;
        memcpy(report.orientation, values, 4 * sizeof(float));
        memcpy(report.acceleration_g, values + 4, 3 * sizeof(float));
        memcpy(report.rotation_deg_per_second, values + 7, 3 * sizeof(float));
        report.crown_reported = values[10]; report.tap = strcmp(tokens[14], "1") == 0;
        if (!one01_watch_report_encode(&report, bytes, sizeof(bytes), &size)) return 0;
        return result_json(&report, bytes, size, output, capacity, written);
    }
    return 0;
}

int main(void) {
    char line[LINE_LIMIT + 1], output[LINE_LIMIT]; size_t line_size = 0, total_output = 0;
    unsigned commands = 0; int input;
    while ((input = fgetc(stdin)) != EOF) {
        if (input == '\n') {
            size_t output_size = 0;
            if (++commands > COMMAND_LIMIT) return 2;
            line[line_size] = '\0';
            if (!command(line, output, sizeof(output), &output_size)) {
                memcpy(output, "null\n", 5); output_size = 5;
            }
            if (total_output > OUTPUT_LIMIT - output_size) return 2;
            if (fwrite(output, 1, output_size, stdout) != output_size) return 2;
            total_output += output_size; line_size = 0;
        } else {
            if (input < 32 || input > 126 || line_size >= LINE_LIMIT) return 2;
            line[line_size++] = (char)input;
        }
    }
    return line_size == 0 ? 0 : 2;
}
