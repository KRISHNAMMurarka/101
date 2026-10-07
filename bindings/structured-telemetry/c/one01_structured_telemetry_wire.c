#include "one01_structured_telemetry_wire.h"
#include <jansson.h>
#include <math.h>
#include <string.h>

/* This is a bounded UTF-8/container-depth preflight, not a JSON grammar parser.
 * Jansson subsequently validates the complete document and rejects duplicates. */
static int preflight(const unsigned char *bytes, size_t size) {
    size_t i = 0, depth = 0;
    int quoted = 0, escaped = 0;
    while (i < size) {
        unsigned char byte = bytes[i];
        uint32_t point;
        size_t width, j;
        if (byte < 0x80) { point = byte; width = 1; }
        else if (byte >= 0xc2 && byte <= 0xdf) { point = byte & 0x1fu; width = 2; }
        else if (byte >= 0xe0 && byte <= 0xef) { point = byte & 0x0fu; width = 3; }
        else if (byte >= 0xf0 && byte <= 0xf4) { point = byte & 0x07u; width = 4; }
        else return 0;
        if (width > size - i) return 0;
        for (j = 1; j < width; j++) {
            if (bytes[i + j] < 0x80 || bytes[i + j] > 0xbf) return 0;
            point = (point << 6) | (bytes[i + j] & 0x3fu);
        }
        if ((width == 2 && point < 0x80) || (width == 3 && point < 0x800) ||
            (width == 4 && point < 0x10000) || point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff) || point == 0xfeff) return 0;
        if ((point >= 0x7f && point <= 0x9f) || (point < 0x20 &&
            (quoted || (point != 9 && point != 10 && point != 13)))) return 0;
        if (quoted) {
            if (escaped) escaped = 0;
            else if (byte == '\\') escaped = 1;
            else if (byte == '"') quoted = 0;
        } else if (byte == '"') quoted = 1;
        else if (byte == '{' || byte == '[') { if (++depth > 3) return 0; }
        else if (byte == '}' || byte == ']') { if (depth == 0) return 0; depth--; }
        i += width;
    }
    return depth == 0 && !quoted && !escaped;
}
static int text_is(const json_t *value, const char *expected) {
    size_t size = strlen(expected);
    return json_is_string(value) && json_string_length(value) == size &&
           memcmp(json_string_value(value), expected, size) == 0;
}
static int epoch_valid(const char epoch[33]) {
    size_t i;
    if (epoch[32] != '\0') return 0;
    for (i = 0; i < 32; i++) {
        if (!((epoch[i] >= '0' && epoch[i] <= '9') || (epoch[i] >= 'a' && epoch[i] <= 'f'))) return 0;
    }
    return 1;
}
static int number(const json_t *value, double *output) {
    double result;
    if (!json_is_number(value)) return 0;
    result = json_number_value(value);
    if (!isfinite(result)) return 0;
    *output = result;
    return 1;
}
static int integer_between(const json_t *value, double minimum, double maximum, double *output) {
    return number(value, output) && *output >= minimum && *output <= maximum && floor(*output) == *output;
}
static int record_decode(const json_t *value, One01ReadingRecord *output) {
    json_t *ready;
    size_t count;
    One01ReadingRecord row = {0, ONE01_COUNT_UP, false, false};
    if (!json_is_object(value)) return 0;
    count = json_object_size(value);
    ready = json_object_get(value, "ready");
    if (count != (ready == NULL ? 2u : 3u) ||
        !number(json_object_get(value, "step"), &row.step) || row.step < 0 || row.step > 100) return 0;
    if (text_is(json_object_get(value, "mode"), "count-up")) row.mode = ONE01_COUNT_UP;
    else if (text_is(json_object_get(value, "mode"), "count-down")) row.mode = ONE01_COUNT_DOWN;
    else return 0;
    if (ready != NULL) {
        if (!json_is_boolean(ready)) return 0;
        row.has_ready = true; row.ready = json_is_true(ready);
    }
    *output = row;
    return 1;
}
int one01_telemetry_decode(const unsigned char *bytes, size_t size,
                          One01TelemetryLane lane, One01TelemetrySample *output) {
    json_t *root, *epoch, *value;
    One01TelemetrySample sample;
    double version, slot, sequence;
    size_t i;
    int valid = 0;
    if (bytes == NULL || output == NULL || lane != ONE01_TELEMETRY_DISPOSABLE ||
        size == 0 || size > ONE01_TELEMETRY_MAX_PACKET_BYTES || !preflight(bytes, size)) return 0;
    /* All public wire numbers have JavaScript's finite double semantics, including
     * timestamps written as integers outside int64_t. Bool is still a distinct type. */
    root = json_loadb((const char *)bytes, size, JSON_REJECT_DUPLICATES | JSON_DECODE_INT_AS_REAL, NULL);
    if (root == NULL) return 0;
    memset(&sample, 0, sizeof(sample));
    if (!json_is_object(root) || json_object_size(root) != 8 ||
        !text_is(json_object_get(root, "protocol"), "connect") ||
        !number(json_object_get(root, "version"), &version) || version != 2 ||
        !text_is(json_object_get(root, "type"), "sample") ||
        !integer_between(json_object_get(root, "slot"), 1, 128, &slot) ||
        !integer_between(json_object_get(root, "sequence"), 1, UINT32_MAX, &sequence) ||
        !number(json_object_get(root, "capturedAt"), &sample.captured_at) || sample.captured_at < 0) goto done;
    epoch = json_object_get(root, "epoch");
    if (!json_is_string(epoch) || json_string_length(epoch) != 32) goto done;
    memcpy(sample.epoch, json_string_value(epoch), 32);
    if (!epoch_valid(sample.epoch)) goto done;
    sample.slot = (uint16_t)slot; sample.sequence = (uint32_t)sequence;
    value = json_object_get(root, "value");
    if (json_is_object(value)) {
        sample.kind = ONE01_TELEMETRY_RECORD; sample.row_count = 1;
        if (!record_decode(value, &sample.rows[0])) goto done;
    } else if (json_is_array(value)) {
        sample.kind = ONE01_TELEMETRY_TABLE; sample.row_count = json_array_size(value);
        if (sample.row_count < 1 || sample.row_count > ONE01_TELEMETRY_MAX_ROWS) goto done;
        for (i = 0; i < sample.row_count; i++) {
            if (!record_decode(json_array_get(value, i), &sample.rows[i])) goto done;
        }
    } else goto done;
    memcpy(output, &sample, sizeof(sample));
    valid = 1;
done:
    json_decref(root);
    return valid;
}
static int sample_valid(const One01TelemetrySample *sample) {
    size_t i;
    if (!epoch_valid(sample->epoch) || sample->slot < 1 || sample->slot > 128 || sample->sequence == 0 ||
        !isfinite(sample->captured_at) || sample->captured_at < 0 ||
        (sample->kind != ONE01_TELEMETRY_RECORD && sample->kind != ONE01_TELEMETRY_TABLE) ||
        sample->row_count < 1 || sample->row_count > ONE01_TELEMETRY_MAX_ROWS ||
        (sample->kind == ONE01_TELEMETRY_RECORD && sample->row_count != 1)) return 0;
    for (i = 0; i < sample->row_count; i++) {
        if (!isfinite(sample->rows[i].step) || sample->rows[i].step < 0 || sample->rows[i].step > 100 ||
            (sample->rows[i].mode != ONE01_COUNT_UP && sample->rows[i].mode != ONE01_COUNT_DOWN)) return 0;
    }
    return 1;
}
/* json_object_set retains its value. This helper releases the temporary ref on
 * both success and failure, with no dependence on _new failure ownership. */
static int put(json_t *object, const char *key, json_t *value) {
    int result;
    if (value == NULL) return 0;
    result = json_object_set(object, key, value);
    json_decref(value);
    return result == 0;
}
static json_t *record_encode(const One01ReadingRecord *row) {
    json_t *object = json_object();
    if (object == NULL) return NULL;
    if (!put(object, "step", json_real(row->step == 0 ? 0 : row->step)) ||
        !put(object, "mode", json_string(row->mode == ONE01_COUNT_UP ? "count-up" : "count-down")) ||
        (row->has_ready && !put(object, "ready", json_boolean(row->ready)))) {
        json_decref(object); return NULL;
    }
    return object;
}
typedef struct {
    unsigned char bytes[ONE01_TELEMETRY_MAX_PACKET_BYTES];
    size_t size;
} EncodedBuffer;
static int collect(const char *bytes, size_t size, void *context) {
    EncodedBuffer *buffer = context;
    if (size > sizeof(buffer->bytes) - buffer->size) return -1;
    memcpy(buffer->bytes + buffer->size, bytes, size);
    buffer->size += size;
    return 0;
}
int one01_telemetry_encode(const One01TelemetrySample *input, unsigned char *bytes,
                          size_t capacity, size_t *encoded_size) {
    One01TelemetrySample sample;
    EncodedBuffer buffer;
    json_t *root = NULL, *value = NULL;
    size_t i;
    int valid = 0;
    if (encoded_size == NULL) return 0;
    *encoded_size = 0;
    if (input == NULL || bytes == NULL || capacity == 0) return 0;
    memcpy(&sample, input, sizeof(sample));
    if (!sample_valid(&sample)) return 0;
    root = json_object();
    if (root == NULL) goto done;
    if (sample.kind == ONE01_TELEMETRY_RECORD) value = record_encode(&sample.rows[0]);
    else {
        value = json_array();
        if (value == NULL) goto done;
        for (i = 0; i < sample.row_count; i++) {
            json_t *row = record_encode(&sample.rows[i]);
            int appended;
            if (row == NULL) goto done;
            appended = json_array_append(value, row); json_decref(row);
            if (appended != 0) goto done;
        }
    }
    if (value == NULL || !put(root, "protocol", json_string("connect")) ||
        !put(root, "version", json_integer(2)) || !put(root, "epoch", json_stringn(sample.epoch, 32)) ||
        !put(root, "slot", json_integer(sample.slot)) || !put(root, "sequence", json_integer(sample.sequence)) ||
        !put(root, "capturedAt", json_real(sample.captured_at == 0 ? 0 : sample.captured_at)) ||
        !put(root, "type", json_string("sample")) || json_object_set(root, "value", value) != 0) goto done;
    buffer.size = 0;
    if (json_dump_callback(root, collect, &buffer, JSON_COMPACT | JSON_SORT_KEYS | JSON_REAL_PRECISION(17)) != 0 ||
        buffer.size == 0 || buffer.size > capacity) goto done;
    memcpy(bytes, buffer.bytes, buffer.size);
    *encoded_size = buffer.size;
    valid = 1;
done:
    json_decref(value); json_decref(root);
    return valid;
}
