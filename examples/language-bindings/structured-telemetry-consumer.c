#include "one01_structured_telemetry_wire.h"
#include <jansson.h>
#include <signal.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Ordinary offline D/E caller. No connection, identity, grant or device APIs.
 * D disposable|reliable HEX
 * E EPOCH SLOT SEQUENCE CAPTURED_AT R STEP count-up|count-down -|0|1
 * E EPOCH SLOT SEQUENCE CAPTURED_AT T COUNT (STEP MODE READY){COUNT}
 * Results are complete JSON lines: null or {hex,packet}. Invalid commands return
 * null. Framing/I/O/total bounds return exit 2, without raw error output. Earlier
 * complete responses may precede a later framing failure; this is a stream. */
#define MAX_COMMANDS 128u
#define MAX_LINE_BYTES 16384u
#define MAX_TOTAL_BYTES 1048576u
#define MAX_FIELDS 31u

typedef struct { unsigned char bytes[MAX_LINE_BYTES]; size_t size; } ResultBuffer;
static int collect(const char *bytes, size_t size, void *context) {
    ResultBuffer *result = context;
    if (size > sizeof(result->bytes) - result->size) return -1;
    memcpy(result->bytes + result->size, bytes, size); result->size += size;
    return 0;
}
static int unsigned_number(const char *text, uint32_t maximum, uint32_t *output) {
    uint32_t value = 0; size_t i;
    if (*text == '\0') return 0;
    for (i = 0; text[i] != '\0'; i++) {
        uint32_t digit;
        if (text[i] < '0' || text[i] > '9') return 0;
        digit = (uint32_t)(text[i] - '0');
        if (digit > maximum || value > (maximum - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    *output = value; return 1;
}
static int finite_number(const char *text, double *output) {
    char *end; double value; size_t i;
    if (*text == '\0') return 0;
    /* Bound the caller's numeric spelling to decimal sign/digits/exponent/dot;
     * strtod supplies the complete standard number conversion. */
    for (i = 0; text[i] != '\0'; i++) {
        if (!((text[i] >= '0' && text[i] <= '9') || text[i] == '-' || text[i] == '+' ||
              text[i] == '.' || text[i] == 'e' || text[i] == 'E')) return 0;
    }
    value = strtod(text, &end);
    if (end == text || *end != '\0' || !isfinite(value)) return 0;
    *output = value; return 1;
}
static int row(char **fields, One01ReadingRecord *output) {
    if (!finite_number(fields[0], &output->step)) return 0;
    if (strcmp(fields[1], "count-up") == 0) output->mode = ONE01_COUNT_UP;
    else if (strcmp(fields[1], "count-down") == 0) output->mode = ONE01_COUNT_DOWN;
    else return 0;
    if (strcmp(fields[2], "-") == 0) { output->has_ready = false; output->ready = false; }
    else if (strcmp(fields[2], "0") == 0) { output->has_ready = true; output->ready = false; }
    else if (strcmp(fields[2], "1") == 0) { output->has_ready = true; output->ready = true; }
    else return 0;
    return 1;
}
static int encoding_input(char **fields, size_t count, One01TelemetrySample *output) {
    uint32_t slot, sequence, rows; size_t i;
    if (count < 7 || strcmp(fields[0], "E") != 0 || strlen(fields[1]) != 32 ||
        !unsigned_number(fields[2], 128, &slot) || !unsigned_number(fields[3], UINT32_MAX, &sequence) ||
        !finite_number(fields[4], &output->captured_at)) return 0;
    memcpy(output->epoch, fields[1], 33); output->slot = (uint16_t)slot; output->sequence = sequence;
    if (strcmp(fields[5], "R") == 0 && count == 9) {
        output->kind = ONE01_TELEMETRY_RECORD; output->row_count = 1;
        return row(fields + 6, &output->rows[0]);
    }
    if (strcmp(fields[5], "T") != 0 || !unsigned_number(fields[6], 8, &rows) || rows < 1 ||
        count != 7 + (size_t)rows * 3) return 0;
    output->kind = ONE01_TELEMETRY_TABLE; output->row_count = rows;
    for (i = 0; i < rows; i++) { if (!row(fields + 7 + i * 3, &output->rows[i])) return 0; }
    return 1;
}
static int nibble(unsigned char byte) {
    if (byte >= '0' && byte <= '9') return byte - '0';
    if (byte >= 'a' && byte <= 'f') return byte - 'a' + 10;
    return -1;
}
static int decoding_input(char **fields, size_t count, One01TelemetrySample *output) {
    unsigned char bytes[ONE01_TELEMETRY_MAX_PACKET_BYTES];
    size_t size, i; One01TelemetryLane lane;
    if (count != 3 || strcmp(fields[0], "D") != 0) return 0;
    if (strcmp(fields[1], "disposable") == 0) lane = ONE01_TELEMETRY_DISPOSABLE;
    else if (strcmp(fields[1], "reliable") == 0) lane = ONE01_TELEMETRY_RELIABLE;
    else return 0;
    size = strlen(fields[2]);
    if (size == 0 || size % 2 != 0 || size > sizeof(bytes) * 2) return 0;
    for (i = 0; i < size / 2; i++) {
        int high = nibble((unsigned char)fields[2][i * 2]), low = nibble((unsigned char)fields[2][i * 2 + 1]);
        if (high < 0 || low < 0) return 0;
        bytes[i] = (unsigned char)(high * 16 + low);
    }
    return one01_telemetry_decode(bytes, size / 2, lane, output);
}
static int result(const One01TelemetrySample *sample, ResultBuffer *output) {
    static const char digits[] = "0123456789abcdef";
    unsigned char bytes[ONE01_TELEMETRY_MAX_PACKET_BYTES]; char hex[ONE01_TELEMETRY_MAX_PACKET_BYTES * 2 + 1];
    size_t size = 0, i; json_t *root = NULL, *packet = NULL, *hex_value = NULL; int valid = 0;
    if (!one01_telemetry_encode(sample, bytes, sizeof(bytes), &size)) return 0;
    for (i = 0; i < size; i++) { hex[i * 2] = digits[bytes[i] >> 4]; hex[i * 2 + 1] = digits[bytes[i] & 15]; }
    hex[size * 2] = '\0';
    packet = json_loadb((const char *)bytes, size, JSON_REJECT_DUPLICATES, NULL);
    root = json_object(); hex_value = json_stringn(hex, size * 2);
    if (packet == NULL || root == NULL || hex_value == NULL || json_object_set(root, "hex", hex_value) != 0 ||
        json_object_set(root, "packet", packet) != 0) goto done;
    output->size = 0;
    valid = json_dump_callback(root, collect, output, JSON_COMPACT | JSON_SORT_KEYS | JSON_REAL_PRECISION(17)) == 0;
done:
    json_decref(hex_value); json_decref(packet); json_decref(root); return valid;
}
static void command(char *line, size_t size, ResultBuffer *output) {
    char *fields[MAX_FIELDS]; size_t count = 0, i = 0; One01TelemetrySample sample;
    output->size = 0; memset(&sample, 0, sizeof(sample));
    for (i = 0; i < size; i++) { if ((unsigned char)line[i] < 32 || (unsigned char)line[i] >= 127) goto invalid; }
    line[size] = '\0'; i = 0;
    while (i < size) {
        while (i < size && line[i] == ' ') i++;
        if (i == size) break;
        if (count == MAX_FIELDS) goto invalid;
        fields[count++] = line + i;
        while (i < size && line[i] != ' ') i++;
        if (i < size) line[i++] = '\0';
    }
    if ((decoding_input(fields, count, &sample) || encoding_input(fields, count, &sample)) && result(&sample, output)) return;
invalid:
    memcpy(output->bytes, "null", 4); output->size = 4;
}
int main(void) {
#ifdef SIGPIPE
    if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 2;
#endif
    char line[MAX_LINE_BYTES + 1]; size_t used = 0, commands = 0, input_bytes = 0, output_bytes = 0;
    int byte;
    while ((byte = fgetc(stdin)) != EOF) {
        ResultBuffer output;
        if (++input_bytes > MAX_TOTAL_BYTES) return 2;
        if (byte != '\n') { if (used == MAX_LINE_BYTES) return 2; line[used++] = (char)byte; continue; }
        if (++commands > MAX_COMMANDS) return 2;
        command(line, used, &output); used = 0;
        if (output.size + 1 > MAX_TOTAL_BYTES - output_bytes) return 2;
        output_bytes += output.size + 1;
        if (fwrite(output.bytes, 1, output.size, stdout) != output.size || fputc('\n', stdout) == EOF) return 2;
    }
    if (used != 0 || ferror(stdin) || fflush(stdout) != 0) return 2;
    return 0;
}
