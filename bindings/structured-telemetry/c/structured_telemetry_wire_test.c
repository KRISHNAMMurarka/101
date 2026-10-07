#include "one01_structured_telemetry_wire.h"
#include <jansson.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Root supplies the pinned, genuinely emitted ordinary SDK fixture receipt. */
#define CHECK(expression) do { if (!(expression)) { \
    fprintf(stderr, "check-failed:%d\n", __LINE__); exit(1); \
} } while (0)

typedef struct { unsigned char data[8192]; size_t size; } TestBuffer;
static int collect(const char *bytes, size_t size, void *context) {
    TestBuffer *buffer = context;
    if (size > sizeof(buffer->data) - buffer->size) return -1;
    memcpy(buffer->data + buffer->size, bytes, size);
    buffer->size += size;
    return 0;
}
static TestBuffer dump(const json_t *value) {
    TestBuffer buffer = {{0}, 0};
    CHECK(json_dump_callback(value, collect, &buffer, JSON_COMPACT | JSON_SORT_KEYS) == 0);
    return buffer;
}
static void put(json_t *object, const char *key, json_t *value) {
    CHECK(value != NULL);
    CHECK(json_object_set(object, key, value) == 0);
    json_decref(value);
}
static json_t *base_packet(void) {
    json_t *packet = json_object(), *row = json_object();
    CHECK(packet != NULL && row != NULL);
    put(packet, "protocol", json_string("connect"));
    put(packet, "version", json_integer(2));
    put(packet, "epoch", json_string("0123456789abcdef0123456789abcdef"));
    put(packet, "slot", json_integer(1));
    put(packet, "sequence", json_integer(1));
    put(packet, "capturedAt", json_real(0));
    put(packet, "type", json_string("sample"));
    put(row, "step", json_real(0));
    put(row, "mode", json_string("count-up"));
    put(packet, "value", row);
    return packet;
}
static void rejected_bytes(const unsigned char *bytes, size_t size, One01TelemetryLane lane) {
    One01TelemetrySample output, before;
    memset(&output, 0x5a, sizeof(output));
    memcpy(&before, &output, sizeof(before));
    CHECK(!one01_telemetry_decode(bytes, size, lane, &output));
    CHECK(memcmp(&output, &before, sizeof(output)) == 0);
}
static void rejected(const json_t *packet) {
    TestBuffer bytes = dump(packet);
    rejected_bytes(bytes.data, bytes.size, ONE01_TELEMETRY_DISPOSABLE);
}
static One01TelemetrySample decoded(const json_t *packet) {
    TestBuffer bytes = dump(packet);
    One01TelemetrySample result;
    CHECK(one01_telemetry_decode(bytes.data, bytes.size, ONE01_TELEMETRY_DISPOSABLE, &result));
    return result;
}
static int same(const One01TelemetrySample *a, const One01TelemetrySample *b) {
    size_t i;
    if (memcmp(a->epoch, b->epoch, sizeof(a->epoch)) != 0 || a->slot != b->slot ||
        a->sequence != b->sequence || a->captured_at != b->captured_at ||
        a->kind != b->kind || a->row_count != b->row_count) return 0;
    for (i = 0; i < a->row_count; i++) {
        if (a->rows[i].step != b->rows[i].step || a->rows[i].mode != b->rows[i].mode ||
            a->rows[i].has_ready != b->rows[i].has_ready ||
            (a->rows[i].has_ready && a->rows[i].ready != b->rows[i].ready)) return 0;
    }
    return 1;
}
static void reciprocal(const One01TelemetrySample *input) {
    unsigned char bytes[ONE01_TELEMETRY_MAX_PACKET_BYTES];
    size_t size = 0;
    One01TelemetrySample result;
    CHECK(one01_telemetry_encode(input, bytes, sizeof(bytes), &size));
    CHECK(size > 0 && size <= sizeof(bytes));
    CHECK(one01_telemetry_decode(bytes, size, ONE01_TELEMETRY_DISPOSABLE, &result));
    CHECK(same(input, &result));
}
static json_t *genuine_fixtures(void) {
    const char *path = getenv("ONE01_STRUCTURED_FIXTURES");
    static unsigned char bytes[131072];
    FILE *file;
    size_t size;
    json_t *root;
    CHECK(path != NULL && path[0] != '\0');
    file = fopen(path, "rb"); CHECK(file != NULL);
    size = fread(bytes, 1, sizeof(bytes), file);
    CHECK(!ferror(file) && size < sizeof(bytes) && feof(file));
    CHECK(fclose(file) == 0);
    root = json_loadb((const char *)bytes, size, JSON_REJECT_DUPLICATES, NULL);
    CHECK(json_is_object(root));
    CHECK(json_integer_value(json_object_get(root, "schemaVersion")) == 1);
    CHECK(json_is_string(json_object_get(root, "status")));
    CHECK(strcmp(json_string_value(json_object_get(root, "status")), "pass") == 0);
    CHECK(json_is_string(json_object_get(root, "profile")));
    CHECK(strcmp(json_string_value(json_object_get(root, "profile")), "structured-telemetry-json2/1") == 0);
    CHECK(json_array_size(json_object_get(root, "positive")) == 5);
    return root;
}
static void test_genuine_sdk_fixture_and_reciprocal(void) {
    static const char *ids[] = {"record-absent", "record-false", "record-true", "one-row", "eight-rows"};
    static const uint16_t slots[] = {1, 128, 2, 1, 128};
    static const uint32_t sequences[] = {1, UINT32_MAX, 4, 6, 32};
    static const double times[] = {0, 125.5, 9007199254740991.0, 1400.25, 1500.125};
    static const double steps[] = {0, 50.25, 100, 1};
    static const bool ready[] = {false, false, true, false};
    static const bool table_present[] = {false, true, true, false, true, true, false, true};
    static const bool table_ready[] = {false, false, true, false, true, false, false, false};
    json_t *root = genuine_fixtures(), *positive = json_object_get(root, "positive");
    size_t i, j;
    for (i = 0; i < 5; i++) {
        json_t *fixture = json_array_get(positive, i), *wire = json_object_get(fixture, "wireUtf8");
        One01TelemetrySample result, expected;
        memset(&expected, 0, sizeof(expected));
        CHECK(json_is_string(json_object_get(fixture, "id")));
        CHECK(strcmp(json_string_value(json_object_get(fixture, "id")), ids[i]) == 0);
        CHECK(json_is_string(wire));
        CHECK(json_string_length(wire) == (size_t)json_integer_value(json_object_get(fixture, "bytes")));
        CHECK(one01_telemetry_decode((const unsigned char *)json_string_value(wire), json_string_length(wire),
                                    ONE01_TELEMETRY_DISPOSABLE, &result));
        memcpy(expected.epoch, "0123456789abcdef0123456789abcdef", sizeof(expected.epoch));
        expected.slot = slots[i]; expected.sequence = sequences[i]; expected.captured_at = times[i];
        expected.kind = i < 3 ? ONE01_TELEMETRY_RECORD : ONE01_TELEMETRY_TABLE;
        expected.row_count = i == 4 ? 8 : 1;
        for (j = 0; j < expected.row_count; j++) {
            expected.rows[j].step = i == 4 ? (double)j * 12.5 : steps[i];
            expected.rows[j].mode = i == 4 ? (j % 2 == 0 ? ONE01_COUNT_UP : ONE01_COUNT_DOWN)
                                                 : (i == 1 ? ONE01_COUNT_DOWN : ONE01_COUNT_UP);
            expected.rows[j].has_ready = i == 4 ? table_present[j] : i != 0;
            expected.rows[j].ready = i == 4 ? table_ready[j] : ready[i];
        }
        CHECK(same(&result, &expected));
        reciprocal(&result);
        rejected_bytes((const unsigned char *)json_string_value(wire), json_string_length(wire), ONE01_TELEMETRY_RELIABLE);
    }
    json_decref(root);
}
static void test_closed_envelope_and_number_types(void) {
    static const char *keys[] = {"protocol", "version", "epoch", "slot", "sequence", "capturedAt", "type", "value"};
    static const char *numeric[] = {"version", "slot", "sequence", "capturedAt"};
    size_t i;
    for (i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        json_t *packet = base_packet(); CHECK(json_object_del(packet, keys[i]) == 0); rejected(packet); json_decref(packet);
    }
    for (i = 0; i < sizeof(numeric) / sizeof(numeric[0]); i++) {
        json_t *packet = base_packet();
        put(packet, numeric[i], json_true()); rejected(packet);
        put(packet, numeric[i], json_string("1")); rejected(packet);
        put(packet, numeric[i], json_null()); rejected(packet); json_decref(packet);
    }
    {
        json_t *packet = base_packet();
        put(packet, "extra", json_integer(1)); rejected(packet); CHECK(json_object_del(packet, "extra") == 0);
        put(packet, "version", json_integer(1)); rejected(packet);
        put(packet, "version", json_integer(3)); rejected(packet);
        put(packet, "version", json_real(2.1)); rejected(packet);
        put(packet, "version", json_integer(2));
        put(packet, "type", json_string("event")); rejected(packet);
        put(packet, "type", json_string("sample"));
        put(packet, "protocol", json_string("CONNECT")); rejected(packet);
        json_decref(packet);
    }
}
static void test_metadata_bounds_and_large_finite_time(void) {
    static const double slots[] = {0, 129, 1.5, -1};
    static const double sequences[] = {0, 4294967296.0, 1.5, -1};
    static const char *epochs[] = {"", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "0123456789abcdef0123456789abcdeF", "0123456789abcdef0123456789abcdeg"};
    json_t *packet = base_packet(); size_t i;
    for (i = 0; i < 4; i++) { put(packet, "slot", json_real(slots[i])); rejected(packet); }
    put(packet, "slot", json_integer(128));
    for (i = 0; i < 4; i++) { put(packet, "sequence", json_real(sequences[i])); rejected(packet); }
    put(packet, "sequence", json_integer(UINT32_MAX));
    put(packet, "capturedAt", json_real(-0.5)); rejected(packet);
    put(packet, "capturedAt", json_real(1e300));
    { One01TelemetrySample sample = decoded(packet); CHECK(sample.captured_at == 1e300); reciprocal(&sample); }
    {
        static const unsigned char wire[] = "{\"protocol\":\"connect\",\"version\":2,\"epoch\":\"0123456789abcdef0123456789abcdef\",\"slot\":128,\"sequence\":4294967295,\"capturedAt\":100000000000000000000,\"value\":{\"step\":0,\"mode\":\"count-up\"},\"type\":\"sample\"}";
        One01TelemetrySample sample;
        CHECK(one01_telemetry_decode(wire, sizeof(wire) - 1, ONE01_TELEMETRY_DISPOSABLE, &sample));
        CHECK(sample.captured_at == 1e20 && sample.sequence == UINT32_MAX); reciprocal(&sample);
    }
    for (i = 0; i < sizeof(epochs) / sizeof(epochs[0]); i++) { put(packet, "epoch", json_string(epochs[i])); rejected(packet); }
    json_decref(packet);
}
static void test_record_shape_and_optional_boolean(void) {
    json_t *packet = base_packet(), *row = json_object_get(packet, "value");
    One01TelemetrySample absent = decoded(packet), present;
    CHECK(!absent.rows[0].has_ready);
    put(row, "ready", json_false()); present = decoded(packet);
    CHECK(present.rows[0].has_ready && !present.rows[0].ready && !same(&absent, &present));
    put(row, "ready", json_true()); CHECK(decoded(packet).rows[0].ready);
    put(row, "ready", json_integer(0)); rejected(packet);
    put(row, "ready", json_string("false")); rejected(packet);
    put(row, "ready", json_null()); rejected(packet); CHECK(json_object_del(row, "ready") == 0);
    put(row, "step", json_false()); rejected(packet);
    put(row, "step", json_string("0")); rejected(packet);
    put(row, "step", json_real(-0.1)); rejected(packet);
    put(row, "step", json_real(100.1)); rejected(packet);
    put(row, "step", json_real(100));
    put(row, "mode", json_string("other")); rejected(packet);
    put(row, "mode", json_true()); rejected(packet);
    put(row, "mode", json_string("count-down"));
    put(row, "extra", json_false()); rejected(packet); CHECK(json_object_del(row, "extra") == 0);
    CHECK(json_object_del(row, "step") == 0); rejected(packet); put(row, "step", json_real(0));
    CHECK(json_object_del(row, "mode") == 0); rejected(packet);
    put(packet, "value", json_null()); rejected(packet);
    put(packet, "value", json_true()); rejected(packet); json_decref(packet);
}
static void test_table_counts_and_rows(void) {
    json_t *packet = base_packet(), *array = json_array(), *row = json_object_get(packet, "value");
    size_t i; CHECK(array != NULL); json_incref(row);
    put(packet, "value", array); array = json_object_get(packet, "value"); rejected(packet);
    for (i = 0; i < 8; i++) { CHECK(json_array_append(array, row) == 0); }
    { One01TelemetrySample sample = decoded(packet); CHECK(sample.kind == ONE01_TELEMETRY_TABLE && sample.row_count == 8); reciprocal(&sample); }
    CHECK(json_array_append(array, row) == 0); rejected(packet);
    CHECK(json_array_remove(array, 8) == 0);
    CHECK(json_array_set(array, 0, json_null()) == 0); rejected(packet);
    CHECK(json_array_set(array, 0, row) == 0);
    put(row, "step", json_true()); rejected(packet);
    json_decref(row); json_decref(packet);
}
static void test_utf8_depth_controls_and_complete_parser(void) {
    json_t *packet = base_packet(); TestBuffer bytes = dump(packet);
    unsigned char invalid[8192]; size_t i;
    static const unsigned char prefixes[][4] = {{0xef,0xbb,0xbf,0}, {0xc0,0x80,0,0}, {0xed,0xa0,0x80,0}, {0xf4,0x90,0x80,0x80}, {0xff,0,0,0}};
    static const size_t lengths[] = {3,2,3,4,1};
    for (i = 0; i < 5; i++) {
        memcpy(invalid, prefixes[i], lengths[i]); memcpy(invalid + lengths[i], bytes.data, bytes.size);
        rejected_bytes(invalid, bytes.size + lengths[i], ONE01_TELEMETRY_DISPOSABLE);
    }
    for (i = 0; i < bytes.size; i++) { invalid[i * 2] = bytes.data[i]; invalid[i * 2 + 1] = 0; }
    rejected_bytes(invalid, bytes.size * 2, ONE01_TELEMETRY_DISPOSABLE);
    for (i = 0; i < bytes.size; i++) {
        invalid[i * 4] = bytes.data[i]; invalid[i * 4 + 1] = 0; invalid[i * 4 + 2] = 0; invalid[i * 4 + 3] = 0;
    }
    rejected_bytes(invalid, bytes.size * 4, ONE01_TELEMETRY_DISPOSABLE);
    memcpy(invalid, bytes.data, bytes.size); invalid[bytes.size] = 0xc2;
    rejected_bytes(invalid, bytes.size + 1, ONE01_TELEMETRY_DISPOSABLE);
    memcpy(invalid, bytes.data, bytes.size); invalid[bytes.size] = 0xef; invalid[bytes.size + 1] = 0xbb; invalid[bytes.size + 2] = 0xbf;
    rejected_bytes(invalid, bytes.size + 3, ONE01_TELEMETRY_DISPOSABLE);
    for (i = 0; i < 32; i++) {
        if (i == 9 || i == 10 || i == 13) continue;
        invalid[0] = (unsigned char)i; memcpy(invalid + 1, bytes.data, bytes.size);
        rejected_bytes(invalid, bytes.size + 1, ONE01_TELEMETRY_DISPOSABLE);
    }
    invalid[0] = 127; memcpy(invalid + 1, bytes.data, bytes.size);
    rejected_bytes(invalid, bytes.size + 1, ONE01_TELEMETRY_DISPOSABLE);
    invalid[0] = 0xc2; invalid[1] = 0x85; memcpy(invalid + 2, bytes.data, bytes.size);
    rejected_bytes(invalid, bytes.size + 2, ONE01_TELEMETRY_DISPOSABLE);
    rejected_bytes(bytes.data, bytes.size - 1, ONE01_TELEMETRY_DISPOSABLE);
    memcpy(invalid, bytes.data, bytes.size); invalid[bytes.size] = 'x';
    rejected_bytes(invalid, bytes.size + 1, ONE01_TELEMETRY_DISPOSABLE);
    {
        static const char *bad[] = {"[[[[0]]]]", "{\"protocol\":\"connect\",\"protocol\":\"connect\"}", "NaN", "Infinity", "null", "[]"};
        for (i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) rejected_bytes((const unsigned char *)bad[i], strlen(bad[i]), ONE01_TELEMETRY_DISPOSABLE);
    }
    {
        static const unsigned char duplicate[] = "{\"protocol\":\"connect\",\"version\":2,\"version\":2,\"epoch\":\"0123456789abcdef0123456789abcdef\",\"slot\":1,\"sequence\":1,\"capturedAt\":0,\"value\":{\"step\":0,\"mode\":\"count-up\"},\"type\":\"sample\"}";
        static const unsigned char escaped[] = "{\"protocol\":\"conn\\u0065ct\",\"version\":2.0,\"epoch\":\"0123456789abcdef0123456789abcdef\",\"slot\":1e0,\"sequence\":1,\"capturedAt\":0,\"value\":{\"step\":0,\"mode\":\"count-\\u0075p\"},\"type\":\"sample\"}";
        One01TelemetrySample result;
        rejected_bytes(duplicate, sizeof(duplicate) - 1, ONE01_TELEMETRY_DISPOSABLE);
        CHECK(one01_telemetry_decode(escaped, sizeof(escaped) - 1, ONE01_TELEMETRY_DISPOSABLE, &result));
    }
    { unsigned char padded[4097]; One01TelemetrySample result;
      memcpy(padded, bytes.data, bytes.size); memset(padded + bytes.size, ' ', sizeof(padded) - bytes.size);
      CHECK(one01_telemetry_decode(padded, 4096, ONE01_TELEMETRY_DISPOSABLE, &result));
      rejected_bytes(padded, 4097, ONE01_TELEMETRY_DISPOSABLE);
      padded[bytes.size] = '\t'; padded[bytes.size + 1] = '\n'; padded[bytes.size + 2] = '\r';
      CHECK(one01_telemetry_decode(padded, 4096, ONE01_TELEMETRY_DISPOSABLE, &result)); }
    { unsigned char offset[8192]; One01TelemetrySample result;
      memset(offset, 0xff, sizeof(offset)); memcpy(offset + 7, bytes.data, bytes.size);
      CHECK(one01_telemetry_decode(offset + 7, bytes.size, ONE01_TELEMETRY_DISPOSABLE, &result)); }
    json_decref(packet);
}
static void rejected_input(const One01TelemetrySample *sample) {
    unsigned char output[4096], before[4096]; size_t size = 99;
    memset(output, 0x5a, sizeof(output)); memcpy(before, output, sizeof(before));
    CHECK(!one01_telemetry_encode(sample, output, sizeof(output), &size));
    CHECK(size == 0 && memcmp(output, before, sizeof(output)) == 0);
}
static void test_owned_encoder_validation_and_publication(void) {
    json_t *packet = base_packet(); One01TelemetrySample good = decoded(packet), sample;
    unsigned char output[4096], before[4096]; size_t size = 99;
    sample = good; sample.slot = 0; rejected_input(&sample);
    sample = good; sample.slot = 129; rejected_input(&sample);
    sample = good; sample.sequence = 0; rejected_input(&sample);
    sample = good; sample.captured_at = NAN; rejected_input(&sample);
    sample = good; sample.captured_at = INFINITY; rejected_input(&sample);
    sample = good; sample.captured_at = -1; rejected_input(&sample);
    sample = good; sample.rows[0].step = NAN; rejected_input(&sample);
    sample = good; sample.rows[0].step = INFINITY; rejected_input(&sample);
    sample = good; sample.rows[0].step = 101; rejected_input(&sample);
    sample = good; sample.rows[0].mode = (One01ReadingMode)99; rejected_input(&sample);
    sample = good; sample.kind = (One01TelemetryValueKind)99; rejected_input(&sample);
    sample = good; sample.row_count = 0; rejected_input(&sample);
    sample = good; sample.row_count = 2; rejected_input(&sample);
    sample = good; sample.kind = ONE01_TELEMETRY_TABLE; sample.row_count = 9; rejected_input(&sample);
    sample = good; memset(sample.epoch, '0', sizeof(sample.epoch)); rejected_input(&sample);
    sample = good; sample.epoch[0] = 'F'; rejected_input(&sample);
    memset(output, 0x5a, sizeof(output)); memcpy(before, output, sizeof(before));
    CHECK(!one01_telemetry_encode(&good, output, 1, &size));
    CHECK(size == 0 && memcmp(output, before, sizeof(output)) == 0);
    sample = good; sample.captured_at = -0.0; sample.rows[0].step = -0.0;
    CHECK(one01_telemetry_encode(&sample, output, sizeof(output), &size));
    CHECK(one01_telemetry_decode(output, size, ONE01_TELEMETRY_DISPOSABLE, &sample));
    CHECK(!signbit(sample.captured_at) && !signbit(sample.rows[0].step));
    json_decref(packet);
}
static void test_invalid_arguments(void) {
    json_t *packet = base_packet(); TestBuffer bytes = dump(packet);
    One01TelemetrySample sample = decoded(packet); unsigned char output[4096]; size_t size = 99;
    CHECK(!one01_telemetry_decode(NULL, 1, ONE01_TELEMETRY_DISPOSABLE, &sample));
    rejected_bytes(bytes.data, 0, ONE01_TELEMETRY_DISPOSABLE);
    rejected_bytes(bytes.data, bytes.size, (One01TelemetryLane)99);
    CHECK(!one01_telemetry_decode(bytes.data, bytes.size, ONE01_TELEMETRY_DISPOSABLE, NULL));
    CHECK(!one01_telemetry_encode(NULL, output, sizeof(output), &size) && size == 0);
    CHECK(!one01_telemetry_encode(&sample, NULL, sizeof(output), &size));
    CHECK(!one01_telemetry_encode(&sample, output, sizeof(output), NULL));
    json_decref(packet);
}
int main(void) {
    test_genuine_sdk_fixture_and_reciprocal();
    test_closed_envelope_and_number_types();
    test_metadata_bounds_and_large_finite_time();
    test_record_shape_and_optional_boolean();
    test_table_counts_and_rows();
    test_utf8_depth_controls_and_complete_parser();
    test_owned_encoder_validation_and_publication();
    test_invalid_arguments();
    puts("selected-c-groups:8");
    return 0;
}
