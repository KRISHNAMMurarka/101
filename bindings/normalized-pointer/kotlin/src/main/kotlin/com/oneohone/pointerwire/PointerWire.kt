package com.oneohone.pointerwire

import java.nio.ByteBuffer
import java.nio.ByteOrder

enum class PointerLane { RELIABLE, DISPOSABLE }

/** Inert data; this object cannot select or authorize a resource. Epoch arrays are copied. */
class PointerSample(epoch: ByteArray, val slot: Int, val sequence: Long, val capturedAt: Double, val x: Double, val y: Double) {
    init { require(epoch.size == 16) { "Epoch must contain exactly 16 bytes" } }
    private val epochBytes = epoch.copyOf()
    val epoch: ByteArray get() = epochBytes.copyOf()
}

object PointerWire {
    private fun valid(sample: PointerSample): Boolean = sample.epoch.size == 16 && sample.slot in 1..128 &&
        sample.sequence in 1..0xffffffffL && sample.capturedAt.isFinite() && sample.capturedAt >= 0 &&
        sample.x.isFinite() && sample.x in 0.0..1.0 && sample.y.isFinite() && sample.y in 0.0..1.0

    fun encode(sample: PointerSample): ByteArray {
        require(valid(sample)) { "Invalid normalized-pointer/1 sample" }
        val bytes = ByteBuffer.allocate(48).order(ByteOrder.BIG_ENDIAN)
        bytes.putShort(0x434e.toShort()).put(1).put(1).put(sample.epoch)
        bytes.putShort(sample.slot.toShort()).putShort(0).putInt(sample.sequence.toInt())
        bytes.putDouble(sample.capturedAt).putFloat(sample.x.toFloat()).putFloat(sample.y.toFloat()).putInt(0)
        return bytes.array()
    }

    fun decode(data: ByteArray, lane: PointerLane): PointerSample? {
        if (lane != PointerLane.DISPOSABLE || data.size != 48) return null
        val bytes = ByteBuffer.wrap(data.copyOf()).order(ByteOrder.BIG_ENDIAN)
        if (bytes.short.toInt() != 0x434e || bytes.get().toInt() != 1 || bytes.get().toInt() != 1) return null
        val epoch = ByteArray(16); bytes.get(epoch)
        val slot = bytes.short.toInt() and 0xffff
        if (bytes.short.toInt() != 0) return null
        val sequence = bytes.int.toLong() and 0xffffffffL
        val sample = PointerSample(epoch, slot, sequence, bytes.double, bytes.float.toDouble(), bytes.float.toDouble())
        if (bytes.int != 0) return null
        return if (valid(sample)) sample else null
    }
}
