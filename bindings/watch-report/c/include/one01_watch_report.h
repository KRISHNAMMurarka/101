#ifndef ONE01_WATCH_REPORT_H
#define ONE01_WATCH_REPORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ONE01_WATCH_REPORT_BYTES 53u
#define ONE01_WATCH_REPORT_PROFILE "watch-report-c-strict/1"

typedef struct {
    uint16_t sequence;
    uint32_t relay_emission_ms;
    float orientation[4];
    float acceleration_g[3];
    float rotation_deg_per_second[3];
    float crown_reported;
    bool tap;
} One01WatchReport;

/* Strict C profile: byte 52 reserved bits must be zero. Decode leaves output
 * unchanged on rejection. Encode sets output size to zero before validation. */
bool one01_watch_report_decode(const uint8_t *bytes, size_t size, One01WatchReport *output);
bool one01_watch_report_encode(const One01WatchReport *report, uint8_t *bytes,
                               size_t capacity, size_t *encoded_size);

#endif
