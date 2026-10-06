#include "one01_pointer_wire.h"
#include <float.h>
#include <limits.h>
#include <math.h>
#include <string.h>

_Static_assert(CHAR_BIT == 8 && sizeof(float) == 4 && sizeof(double) == 8 && FLT_RADIX == 2 &&
    FLT_MANT_DIG == 24 && FLT_MAX_EXP == 128 && DBL_MANT_DIG == 53 && DBL_MAX_EXP == 1024,
    "normalized-pointer/1 requires IEEE binary32 and binary64");

static int valid(const one01_pointer_sample *sample) {
    return sample && sample->slot >= 1 && sample->slot <= 128 && sample->sequence > 0 &&
        isfinite(sample->captured_at) && sample->captured_at >= 0 &&
        isfinite(sample->x) && sample->x >= 0 && sample->x <= 1 && isfinite(sample->y) && sample->y >= 0 && sample->y <= 1;
}
static void write_integer(uint8_t *bytes, size_t offset, size_t width, uint64_t value) {
    for (size_t i = 0; i < width; ++i) bytes[offset + i] = (uint8_t)(value >> ((width - i - 1) * 8));
}
static uint64_t read_integer(const uint8_t *bytes, size_t offset, size_t width) {
    uint64_t value = 0;
    for (size_t i = 0; i < width; ++i) value = (value << 8) | bytes[offset + i];
    return value;
}
/* IEEE round-to-nearest, ties-to-even using integer bits. Caller rounding/exception state is untouched. */
static uint32_t coordinate_bits(double value) {
    uint64_t bits; memcpy(&bits, &value, sizeof bits);
    uint32_t sign = (uint32_t)(bits >> 32) & UINT32_C(0x80000000);
    unsigned encoded_exponent = (unsigned)((bits >> 52) & UINT64_C(0x7ff));
    if (!encoded_exponent) return sign;
    int exponent = (int)encoded_exponent - 1023;
    if (exponent < -150) return sign;
    uint64_t significand = (bits & UINT64_C(0x000fffffffffffff)) | (UINT64_C(1) << 52);
    unsigned shift = exponent >= -126 ? 29 : (unsigned)(-97 - exponent);
    uint64_t rounded = significand >> shift;
    uint64_t remainder = significand & ((UINT64_C(1) << shift) - 1), half = UINT64_C(1) << (shift - 1);
    if (remainder > half || (remainder == half && (rounded & 1))) rounded++;
    uint32_t base = exponent >= -126 ? (uint32_t)(exponent + 126) << 23 : 0;
    return sign | (base + (uint32_t)rounded);
}
one01_pointer_status one01_pointer_encode(const one01_pointer_sample *sample, uint8_t *output, size_t output_length) {
    if (!output || output_length != ONE01_POINTER_BYTES || !valid(sample)) return ONE01_POINTER_INVALID;
    uint8_t bytes[ONE01_POINTER_BYTES] = {0}; uint64_t time; uint32_t x_bits, y_bits;
    memcpy(&time, &sample->captured_at, sizeof time); x_bits = coordinate_bits(sample->x); y_bits = coordinate_bits(sample->y);
    bytes[0] = 0x43; bytes[1] = 0x4e; bytes[2] = 1; bytes[3] = 1; memcpy(bytes + 4, sample->epoch, 16);
    write_integer(bytes, 20, 2, sample->slot); write_integer(bytes, 24, 4, sample->sequence);
    write_integer(bytes, 28, 8, time); write_integer(bytes, 36, 4, x_bits); write_integer(bytes, 40, 4, y_bits);
    memcpy(output, bytes, sizeof bytes); return ONE01_POINTER_OK;
}
one01_pointer_status one01_pointer_decode(const uint8_t *bytes, size_t length, one01_pointer_lane lane, one01_pointer_sample *output) {
    if (!bytes || !output || length != ONE01_POINTER_BYTES || lane != ONE01_POINTER_DISPOSABLE ||
        bytes[0] != 0x43 || bytes[1] != 0x4e || bytes[2] != 1 || bytes[3] != 1 ||
        bytes[22] || bytes[23] || bytes[44] || bytes[45] || bytes[46] || bytes[47]) return ONE01_POINTER_INVALID;
    one01_pointer_sample sample = {0}; uint64_t time = read_integer(bytes, 28, 8);
    uint32_t x_bits = (uint32_t)read_integer(bytes, 36, 4), y_bits = (uint32_t)read_integer(bytes, 40, 4); float x, y;
    memcpy(sample.epoch, bytes + 4, 16); sample.slot = (uint16_t)read_integer(bytes, 20, 2); sample.sequence = (uint32_t)read_integer(bytes, 24, 4);
    memcpy(&sample.captured_at, &time, sizeof time); memcpy(&x, &x_bits, sizeof x); memcpy(&y, &y_bits, sizeof y); sample.x = x; sample.y = y;
    if (!valid(&sample)) return ONE01_POINTER_INVALID;
    memcpy(output, &sample, sizeof sample); return ONE01_POINTER_OK;
}
