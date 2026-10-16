#include "one01_watch_report.h"

#include <float.h>
#include <math.h>
#include <string.h>

_Static_assert(sizeof(float) == 4, "watch-report requires binary32 float");
_Static_assert(FLT_RADIX == 2 && FLT_MANT_DIG == 24 && FLT_MAX_EXP == 128,
               "watch-report requires IEEE-754 binary32 float");

static uint16_t read_u16(const uint8_t *bytes) {
    return (uint16_t)((uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8));
}

static uint32_t read_u32(const uint8_t *bytes) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
           ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static void write_u16(uint8_t *bytes, uint16_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

static void write_u32(uint8_t *bytes, uint32_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
    bytes[2] = (uint8_t)(value >> 16);
    bytes[3] = (uint8_t)(value >> 24);
}

static float read_f32(const uint8_t *bytes) {
    uint32_t bits = read_u32(bytes);
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

static void write_f32(uint8_t *bytes, float value) {
    uint32_t bits;
    memcpy(&bits, &value, sizeof(bits));
    write_u32(bytes, bits);
}

static bool report_finite(const One01WatchReport *report) {
    size_t index;
    for (index = 0; index < 4; index++) if (!isfinite(report->orientation[index])) return false;
    for (index = 0; index < 3; index++) {
        if (!isfinite(report->acceleration_g[index]) ||
            !isfinite(report->rotation_deg_per_second[index])) return false;
    }
    return isfinite(report->crown_reported);
}

bool one01_watch_report_decode(const uint8_t *bytes, size_t size, One01WatchReport *output) {
    One01WatchReport value;
    size_t offset = 8, index;
    if (bytes == NULL || output == NULL || size != ONE01_WATCH_REPORT_BYTES ||
        bytes[0] != 0x31u || bytes[1] != 1u || (bytes[52] & 0xfeu) != 0u) return false;
    value.sequence = read_u16(bytes + 2);
    value.relay_emission_ms = read_u32(bytes + 4);
    for (index = 0; index < 4; index++, offset += 4) value.orientation[index] = read_f32(bytes + offset);
    for (index = 0; index < 3; index++, offset += 4) value.acceleration_g[index] = read_f32(bytes + offset);
    for (index = 0; index < 3; index++, offset += 4) value.rotation_deg_per_second[index] = read_f32(bytes + offset);
    value.crown_reported = read_f32(bytes + offset);
    value.tap = (bytes[52] & 1u) != 0u;
    if (!report_finite(&value)) return false;
    *output = value;
    return true;
}

bool one01_watch_report_encode(const One01WatchReport *report, uint8_t *bytes,
                               size_t capacity, size_t *encoded_size) {
    uint8_t encoded[ONE01_WATCH_REPORT_BYTES];
    size_t offset = 8, index;
    if (encoded_size == NULL) return false;
    *encoded_size = 0;
    if (report == NULL || bytes == NULL || capacity < ONE01_WATCH_REPORT_BYTES || !report_finite(report)) return false;
    encoded[0] = 0x31u; encoded[1] = 1u;
    write_u16(encoded + 2, report->sequence);
    write_u32(encoded + 4, report->relay_emission_ms);
    for (index = 0; index < 4; index++, offset += 4) write_f32(encoded + offset, report->orientation[index]);
    for (index = 0; index < 3; index++, offset += 4) write_f32(encoded + offset, report->acceleration_g[index]);
    for (index = 0; index < 3; index++, offset += 4) write_f32(encoded + offset, report->rotation_deg_per_second[index]);
    write_f32(encoded + offset, report->crown_reported);
    encoded[52] = report->tap ? 1u : 0u;
    memcpy(bytes, encoded, sizeof(encoded));
    *encoded_size = sizeof(encoded);
    return true;
}
