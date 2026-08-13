package com.oneohone.wear

/**
 * Decides which sensor readings are worth putting on the wire.
 *
 * Wear OS sensors deliver far faster than the link needs, and the Data Layer shares a constrained
 * Bluetooth channel with the rest of the system. This drops to a fixed budget while moving, and —
 * the part that matters — always sends the sample where motion stops. Without that, a game keeps
 * applying the last motion reading after the wearer's wrist has already come to rest.
 *
 * Mirrors `WatchSamplePolicy` on watchOS so both watches behave identically.
 */
class SamplePolicy(
    hertz: Double = 50.0,
    idleHertz: Double = 6.0,
    private val motionEpsilon: Double = 0.02,
) {
    init {
        require(hertz > 0 && idleHertz > 0) { "Watch sample rates must be positive" }
    }

    private val minimumIntervalMs = 1000.0 / hertz
    private val idleIntervalMs = 1000.0 / idleHertz
    private var lastSentAt = Double.NEGATIVE_INFINITY
    private var lastWasMoving = false

    fun shouldSend(timestampMs: Double, magnitude: Double, tap: Boolean): Boolean {
        // A tap is a discrete intent. Never rate-limit it away.
        if (tap) {
            lastSentAt = timestampMs
            lastWasMoving = magnitude > motionEpsilon
            return true
        }

        val moving = magnitude > motionEpsilon
        val settled = lastWasMoving && !moving
        val interval = if (moving) minimumIntervalMs else idleIntervalMs
        val due = timestampMs - lastSentAt >= interval

        if (!settled && !due) return false
        lastSentAt = timestampMs
        lastWasMoving = moving
        return true
    }

    fun reset() {
        lastSentAt = Double.NEGATIVE_INFINITY
        lastWasMoving = false
    }
}
