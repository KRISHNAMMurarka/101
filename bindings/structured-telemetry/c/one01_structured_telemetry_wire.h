#ifndef ONE01_STRUCTURED_TELEMETRY_WIRE_H
#define ONE01_STRUCTURED_TELEMETRY_WIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ONE01_TELEMETRY_MAX_PACKET_BYTES 4096u
#define ONE01_TELEMETRY_MAX_ROWS 8u
#define ONE01_TELEMETRY_PROFILE "structured-telemetry-json2/1"

typedef enum {
    ONE01_TELEMETRY_RELIABLE = 0,
    ONE01_TELEMETRY_DISPOSABLE = 1
} One01TelemetryLane;
typedef enum { ONE01_COUNT_UP = 0, ONE01_COUNT_DOWN = 1 } One01ReadingMode;
typedef enum { ONE01_TELEMETRY_RECORD = 0, ONE01_TELEMETRY_TABLE = 1 } One01TelemetryValueKind;

typedef struct {
    double step;
    One01ReadingMode mode;
    bool has_ready;
    bool ready;
} One01ReadingRecord;
typedef struct {
    char epoch[33];
    uint16_t slot;
    uint32_t sequence;
    double captured_at;
    One01TelemetryValueKind kind;
    size_t row_count;
    One01ReadingRecord rows[ONE01_TELEMETRY_MAX_ROWS];
} One01TelemetrySample;

/* Inert, selected sample codec. No permission, identity, transport or freshness
 * authority is created. Jansson is provided by the consumer, not redistributed.
 * Caller pointers must identify valid, stable, nonoverlapping owned memory.
 * Return 1 on success, 0 on failure. Decode leaves output unchanged on failure.
 * Encode captures the fixed input, validates it, and only publishes complete
 * bytes on success. Failure sets encoded_size to zero and leaves bytes unchanged.
 * Semantic roundtrip is promised; JSON key order/number spelling is not canonical.
 * Duplicate JSON keys are refused in this closed producer profile. */
int one01_telemetry_decode(const unsigned char *bytes, size_t size,
                          One01TelemetryLane lane, One01TelemetrySample *output);
int one01_telemetry_encode(const One01TelemetrySample *input, unsigned char *bytes,
                          size_t capacity, size_t *encoded_size);

#endif
