# M09 device health and resource-limit contract

## Outcome

A local provider can publish a bounded health snapshot for one exact device.
It describes optional battery and firmware information, thermal and
connectivity states, distinct hardware faults, and per-capability availability
and supported limits. A consumer must check the snapshot's clock identity and
age before using its readiness claim. Unknown devices/resources, stale reports,
blocking faults and offline/critical states cannot advertise availability.
The data does not establish that a physical provider is present or that its
reported hardware state is truthful.

## Snapshot

`DeviceHealthReport` is a closed schema 1 object with `deviceId`,
`observed:{clockId,at}`, `maxAgeMs` in (0,60000], `battery`, `thermal`,
`firmware`, `connectivity`, `faults` and `resources`. Battery is `null` for a
device without an observable battery, or `{levelPercent,charging}` with finite
percent in [0,100]. Firmware is `null` when not reported, or `{version}` with a
bounded non-control string. Thermal is `nominal|elevated|critical|unknown`.
Connectivity is `connected|degraded|offline|unknown|not-applicable`; the latter
describes a local device. Neither battery percentage nor firmware text alone
derives readiness.

Faults are up to eight distinct `{code,severity}` items with namespaced code
and `warning|blocking` severity. Resources are one to 32 distinct
`{capabilityId,state,maxHz,maxActiveRoutes}` entries where state is
`available|unavailable|busy|denied`; `maxHz` is finite in (0,1000] and
`maxActiveRoutes` is an integer in [1,4096]. These are provider-reported
ceilings, not runtime quotas. Unknown fields, unsafe objects, duplicate IDs,
malformed ranges and oversized input reject. Parsed output is immutable.

## Assessment and first caller

`assessDeviceHealth(report, expectedDeviceId, capabilityId, now)` validates
the complete report and a `ClockStamp`. It rejects a foreign clock or a time
before observation. If age exceeds `maxAgeMs`, readiness is `stale` without
limits. Wrong device or unknown resource returns `unavailable`. An explicit
resource state, critical thermal state, offline connectivity or blocking fault
prevents availability. Otherwise it returns `available` plus that resource's
reported maxHz and maxActiveRoutes. The helper never upgrades a report to a
working route or silently infers availability from battery/firmware.

The embedded temperature example accepts such a report for its exact device
and capability and applies the readiness result and expiry to its existing
runtime source. The runtime rechecks expiry on route start, publication,
flush and renewal; no idle background timer runs. A loss closes active routes
and pending commands; recovery requires
new authorization and routing. The example retains the parsed health report
for diagnostics. It does not enforce the reported rate or route ceilings;
provider binding and live limit negotiation remain later work.
