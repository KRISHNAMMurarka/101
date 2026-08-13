package com.oneohone.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchPayloadTest {
    @Test
    fun `payload survives a round trip`() {
        val payload = WatchPayload(
            sequence = 4321,
            milliseconds = 1_234_567,
            orientation = floatArrayOf(0.1f, -0.2f, 0.3f, 0.927f),
            acceleration = floatArrayOf(0.5f, -1.25f, 0.125f),
            rotationRate = floatArrayOf(120.5f, -45.25f, 8f),
            crown = 42.5f,
            tap = true,
        )
        val encoded = payload.encode()
        assertEquals(WatchPayload.BYTE_COUNT, encoded.size)
        assertEquals(payload, WatchPayload.decode(encoded))
    }

    @Test
    fun `decode rejects junk instead of throwing`() {
        assertNull(WatchPayload.decode(ByteArray(0)))
        assertNull("a zeroed buffer has no magic byte", WatchPayload.decode(ByteArray(WatchPayload.BYTE_COUNT)))
        assertNull("a short packet is rejected", WatchPayload.decode(ByteArray(8) { WatchPayload.MAGIC }))

        val wrongVersion = sample().encode().also { it[1] = 99 }
        assertNull("an unknown protocol version is rejected", WatchPayload.decode(wrongVersion))
    }

    @Test
    fun `a non-finite quaternion never reaches the motion pipeline`() {
        val poisoned = sample().encode()
        val bits = java.lang.Float.floatToRawIntBits(Float.NaN)
        for (index in 0..3) poisoned[8 + index] = ((bits shr (index * 8)) and 0xFF).toByte()
        assertNull(WatchPayload.decode(poisoned))
    }

    @Test
    fun `the wire format matches the watchOS relay byte for byte`() {
        // Both platforms must agree exactly, or the phone would decode one watch and not the other.
        val encoded = WatchPayload(
            sequence = 1,
            milliseconds = 0,
            orientation = floatArrayOf(0f, 0f, 0f, 1f),
            acceleration = floatArrayOf(0f, 0f, 0f),
            rotationRate = floatArrayOf(0f, 0f, 0f),
            crown = 0f,
            tap = false,
        ).encode()
        assertEquals(53, encoded.size)
        assertEquals(0x31.toByte(), encoded[0])
        assertEquals(1.toByte(), encoded[1])
        // Little-endian 1.0f is 00 00 80 3F, at the quaternion w slot (offset 20).
        assertEquals(0x00.toByte(), encoded[20])
        assertEquals(0x00.toByte(), encoded[21])
        assertEquals(0x80.toByte(), encoded[22])
        assertEquals(0x3F.toByte(), encoded[23])
    }

    private fun sample() = WatchPayload(
        sequence = 1,
        milliseconds = 1,
        orientation = floatArrayOf(0f, 0f, 0f, 1f),
        acceleration = floatArrayOf(0f, 0f, 0f),
        rotationRate = floatArrayOf(0f, 0f, 0f),
        crown = 0f,
        tap = false,
    )
}

class WearLinkStateTest {
    @Test
    fun `locality is never claimed local without a nearby node`() {
        val connectedButFar = WearLinkState(companionPaired = true, appInstalled = true, reachable = true, nearby = false)
        assertEquals(WearLocality.CLOUD_POSSIBLE, connectedButFar.locality)
        assertFalse(connectedButFar.strictlyLocal)
        assertTrue("a routed path is still playable if the wearer accepts it", connectedButFar.canRelayRealtime)
        assertTrue(connectedButFar.note.contains("may route"))

        val nearby = connectedButFar.copy(nearby = true)
        assertEquals(WearLocality.VERIFIED_LOCAL, nearby.locality)
        assertTrue(nearby.strictlyLocal)
    }

    @Test
    fun `an incomplete pairing reports unknown rather than guessing`() {
        assertEquals(WearLocality.UNKNOWN, WearLinkState().locality)
        assertEquals(WearLocality.UNKNOWN, WearLinkState(companionPaired = true).locality)
        assertEquals(WearLocality.UNKNOWN, WearLinkState(companionPaired = true, appInstalled = true).locality)
    }
}

class SamplePolicyTest {
    @Test
    fun `motion is rate limited but settling is always reported`() {
        val policy = SamplePolicy(hertz = 50.0, idleHertz = 6.0)
        assertTrue("the first moving sample is sent", policy.shouldSend(0.0, 1.0, false))
        assertFalse("50 Hz means 5 ms later is too soon", policy.shouldSend(5.0, 1.0, false))
        assertTrue(policy.shouldSend(30.0, 1.0, false))
        // Coming to rest must reach the game, otherwise the last motion stays applied forever.
        assertTrue("settling is always reported", policy.shouldSend(31.0, 0.0, false))
        assertFalse("a still wrist then drops to the idle rate", policy.shouldSend(40.0, 0.0, false))
        assertTrue(policy.shouldSend(250.0, 0.0, false))
    }

    @Test
    fun `taps are never rate limited away`() {
        val policy = SamplePolicy(hertz = 50.0, idleHertz = 6.0)
        assertTrue(policy.shouldSend(0.0, 1.0, false))
        assertTrue("a discrete tap outranks the rate limit", policy.shouldSend(1.0, 1.0, true))
    }
}
