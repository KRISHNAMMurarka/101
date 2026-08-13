package com.oneohone.wear

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Compact binary wire format for wrist samples, byte-identical to the watchOS relay in
 * `apps/watch-ios/Sources/One01WatchCore/WatchPayload.swift`.
 *
 * Keeping one layout across both platforms means the phone side decodes wrist input the same way
 * regardless of which watch produced it, and `@101/adapter-watch` needs no per-platform branch.
 *
 * Layout (53 bytes, little-endian):
 * ```
 *  0      magic 0x31
 *  1      version
 *  2..3   sequence            u16
 *  4..7   milliseconds        u32   (since the relay started, not wall clock)
 *  8..23  orientation x,y,z,w f32 x4
 * 24..35  acceleration x,y,z  f32 x3 (g, gravity removed)
 * 36..47  rotationRate x,y,z  f32 x3 (degrees/second)
 * 48..51  crown travel        f32    (detents, monotonic)
 * 52      buttons bitfield    u8     (bit 0: tap)
 * ```
 *
 * Nothing here identifies the wearer or their health. 101 treats a watch as a motion controller
 * and nothing else.
 */
data class WatchPayload(
    val sequence: Int,
    val milliseconds: Long,
    val orientation: FloatArray,
    val acceleration: FloatArray,
    val rotationRate: FloatArray,
    val crown: Float,
    val tap: Boolean,
) {
    init {
        require(orientation.size == 4) { "orientation must be a quaternion" }
        require(acceleration.size == 3) { "acceleration must be a 3-vector" }
        require(rotationRate.size == 3) { "rotationRate must be a 3-vector" }
    }

    fun encode(): ByteArray {
        val buffer = ByteBuffer.allocate(BYTE_COUNT).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put(MAGIC)
        buffer.put(VERSION)
        buffer.putShort((sequence and 0xFFFF).toShort())
        buffer.putInt((milliseconds and 0xFFFFFFFFL).toInt())
        orientation.forEach(buffer::putFloat)
        acceleration.forEach(buffer::putFloat)
        rotationRate.forEach(buffer::putFloat)
        buffer.putFloat(crown)
        buffer.put(if (tap) 1 else 0)
        return buffer.array()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is WatchPayload) return false
        return sequence == other.sequence &&
            milliseconds == other.milliseconds &&
            orientation.contentEquals(other.orientation) &&
            acceleration.contentEquals(other.acceleration) &&
            rotationRate.contentEquals(other.rotationRate) &&
            crown == other.crown &&
            tap == other.tap
    }

    override fun hashCode(): Int {
        var result = sequence
        result = 31 * result + milliseconds.hashCode()
        result = 31 * result + orientation.contentHashCode()
        result = 31 * result + acceleration.contentHashCode()
        result = 31 * result + rotationRate.contentHashCode()
        result = 31 * result + crown.hashCode()
        result = 31 * result + tap.hashCode()
        return result
    }

    companion object {
        const val BYTE_COUNT = 53
        const val MAGIC: Byte = 0x31
        const val VERSION: Byte = 1

        /** Returns null rather than throwing on a short, misaligned or foreign packet. */
        fun decode(data: ByteArray): WatchPayload? {
            if (data.size != BYTE_COUNT) return null
            val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
            if (buffer.get() != MAGIC || buffer.get() != VERSION) return null

            val sequence = buffer.short.toInt() and 0xFFFF
            val milliseconds = buffer.int.toLong() and 0xFFFFFFFFL
            val orientation = FloatArray(4) { buffer.float }
            val acceleration = FloatArray(3) { buffer.float }
            val rotationRate = FloatArray(3) { buffer.float }
            val crown = buffer.float
            val tap = (buffer.get().toInt() and 0x01) == 0x01

            // A non-finite value would poison the motion pipeline downstream.
            val finite = orientation.all { it.isFinite() } &&
                acceleration.all { it.isFinite() } &&
                rotationRate.all { it.isFinite() } &&
                crown.isFinite()
            if (!finite) return null

            return WatchPayload(sequence, milliseconds, orientation, acceleration, rotationRate, crown, tap)
        }
    }
}
