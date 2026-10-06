#ifndef ONE01_POINTER_WIRE_H
#define ONE01_POINTER_WIRE_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { ONE01_POINTER_BYTES = 48 };
typedef enum { ONE01_POINTER_RELIABLE = 0, ONE01_POINTER_DISPOSABLE = 1 } one01_pointer_lane;
typedef enum { ONE01_POINTER_OK = 0, ONE01_POINTER_INVALID = 1 } one01_pointer_status;
/* Inert decoded data; epoch/slot fields carry no resource authority or freshness verdict. */
typedef struct {
    uint8_t epoch[16];
    uint16_t slot;
    uint32_t sequence;
    double captured_at;
    double x;
    double y;
} one01_pointer_sample;

/* Output is unchanged on failure. Encoding accepts exactly a 48-byte output buffer.
 * Coordinates use nearest-ties-even regardless of caller rounding mode; the floating environment is unchanged. */
one01_pointer_status one01_pointer_encode(const one01_pointer_sample *sample, uint8_t *output, size_t output_length);
one01_pointer_status one01_pointer_decode(const uint8_t *bytes, size_t length, one01_pointer_lane lane, one01_pointer_sample *output);

#ifdef __cplusplus
}
#endif
#endif
