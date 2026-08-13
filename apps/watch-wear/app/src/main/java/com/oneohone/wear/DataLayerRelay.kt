package com.oneohone.wear

import android.content.Context
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await

/**
 * Relays wrist samples to 101 Link on the paired phone over the Wearable Data Layer.
 *
 * Only [MessageClient.sendMessage] is used. `DataClient` items are synced state, not events: they
 * are deduplicated, may be delayed, and are explicitly documented as possibly travelling over the
 * network. Neither property is acceptable for a controller, so the realtime path uses messages and
 * drops samples when no route exists rather than buffering stale motion.
 *
 * The phone half of this pairing advertises the [LINK_CAPABILITY] capability, which is how the
 * watch finds it without hardcoding a node ID.
 */
class DataLayerRelay(context: Context) {
    private val messageClient: MessageClient = Wearable.getMessageClient(context)
    private val nodeClient = Wearable.getNodeClient(context)
    private val capabilityClient: CapabilityClient = Wearable.getCapabilityClient(context)
    private val policy = SamplePolicy()

    private var sequence = 0
    private var target: Node? = null

    var state: WearLinkState = WearLinkState()
        private set

    var sent: Int = 0
        private set

    var dropped: Int = 0
        private set

    /**
     * Refreshes the route.
     *
     * Locality is derived from [Node.isNearby], never assumed. When several nodes are connected a
     * nearby one is preferred, precisely so the honest answer is also the best-performing one.
     */
    suspend fun refresh(): WearLinkState {
        val connected = runCatching { awaitConnectedNodes() }.getOrDefault(emptyList())
        val capable = runCatching {
            capabilityClient.getCapability(LINK_CAPABILITY, CapabilityClient.FILTER_REACHABLE).await().nodes
        }.getOrDefault(emptySet())

        val candidates = connected.filter { node -> capable.any { it.id == node.id } }
        target = candidates.firstOrNull { it.isNearby } ?: candidates.firstOrNull()

        state = WearLinkState(
            companionPaired = connected.isNotEmpty(),
            appInstalled = candidates.isNotEmpty(),
            reachable = target != null,
            nearby = target?.isNearby == true,
        )
        if (!state.canRelayRealtime) policy.reset()
        return state
    }

    fun relay(
        timestampMs: Double,
        orientation: FloatArray,
        acceleration: FloatArray,
        rotationRate: FloatArray,
        crown: Float,
        tap: Boolean,
    ) {
        val node = target
        if (node == null || !state.canRelayRealtime) {
            if (tap) dropped += 1
            return
        }

        val magnitude = acceleration.sumOf { kotlin.math.abs(it).toDouble() } +
            rotationRate.sumOf { kotlin.math.abs(it).toDouble() } / 180.0
        if (!policy.shouldSend(timestampMs, magnitude, tap)) return

        sequence = (sequence + 1) and 0xFFFF
        val payload = WatchPayload(
            sequence = sequence,
            milliseconds = timestampMs.toLong(),
            orientation = orientation,
            acceleration = acceleration,
            rotationRate = rotationRate,
            crown = crown,
            tap = tap,
        )
        messageClient.sendMessage(node.id, SAMPLE_PATH, payload.encode())
            .addOnFailureListener { dropped += 1 }
        sent += 1
    }

    private suspend fun awaitConnectedNodes(): List<Node> = nodeClient.connectedNodes.await()

    companion object {
        /** Declared by the phone app in res/values/wear.xml so the watch can find it. */
        const val LINK_CAPABILITY = "one01_link"

        /** Realtime wrist samples. Binary, unacknowledged, disposable. */
        const val SAMPLE_PATH = "/101/watch/sample"

        /** Reliable control messages such as calibration requests and haptic commands. */
        const val CONTROL_PATH = "/101/watch/control"
    }
}
