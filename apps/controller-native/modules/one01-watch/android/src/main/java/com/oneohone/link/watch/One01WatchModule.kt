package com.oneohone.link.watch

import android.util.Base64
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.tasks.await

/**
 * Phone-side receiver for wrist samples relayed by the 101 Wear OS companion.
 *
 * This is the counterpart of `apps/watch-wear`. Only [MessageClient] is handled: `DataClient` items
 * are synced state, deduplicated and possibly delayed, which is wrong for a controller.
 *
 * Locality is reported, never assumed. The Wearable Data Layer may route over the network rather
 * than Bluetooth, so this passes [Node.isNearby] up to JavaScript and lets `@101/adapter-watch`
 * decide what may honestly be claimed.
 */
class One01WatchModule : Module() {
  private val listener = MessageClient.OnMessageReceivedListener { event -> onMessage(event) }
  private var started = false
  private val resourceLock = Any()
  private var resourceEpoch = 0
  private var resourceAttempts = 0
  private var resourceNodeId: String? = null
  private var resourceStarted = false
  private var resourceListenerEpoch: Int? = null
  private val resourceListener = MessageClient.OnMessageReceivedListener { event -> onResourceMessage(event) }
  private val resourceCapabilityListener = CapabilityClient.OnCapabilityChangedListener { info: CapabilityInfo ->
    val lost = synchronized(resourceLock) { resourceNodeId?.let { id -> info.nodes.none { it.id == id } } ?: false }
    if (lost) retireResources()
  }

  override fun definition() = ModuleDefinition {
    Name("One01Watch")

    Events("onWatchSample", "onWatchLinkChange", "onWatchResourceSample", "onWatchResourceLoss")

    Function("isSupported") {
      // The Data Layer is provided by Play Services; a device without it cannot receive samples.
      appContext.reactContext != null
    }

    // Node discovery is asynchronous, so these bodies are coroutines rather than plain blocks.
    AsyncFunction("start") Coroutine { ->
      val context = requireContext()
      if (!started) {
        Wearable.getMessageClient(context).addListener(listener)
        started = true
      }
      snapshot()
    }

    AsyncFunction("stop") {
      if (started) {
        Wearable.getMessageClient(requireContext()).removeListener(listener)
        started = false
      }
    }

    AsyncFunction("getLinkState") Coroutine { ->
      snapshot()
    }

    AsyncFunction("enrollResources") Coroutine { ->
      // Resolve through the native reachable capability set. A JS node/player string is never accepted.
      val epoch = synchronized(resourceLock) {
        check(resourceNodeId == null && resourceListenerEpoch == null && resourceAttempts < 64) { "Watch resource scope unavailable." }
        resourceAttempts += 1
        resourceEpoch += 1
        resourceEpoch
      }
      val node = preferredNode() ?: throw IllegalStateException("Watch resources unavailable.")
      check(node.id.length in 1..128) { "Watch resource identity unavailable." }
      synchronized(resourceLock) {
        check(resourceEpoch == epoch && resourceNodeId == null) { "Watch resource scope changed." }
        resourceNodeId = node.id
      }
      mapOf("platform" to "wearos", "companionPaired" to true, "appInstalled" to true,
        "reachable" to true, "nearby" to node.isNearby, "epoch" to epoch)
    }
    AsyncFunction("startResources") Coroutine { epoch: Int ->
      val context = requireContext()
      synchronized(resourceLock) {
        check(resourceEpoch == epoch && resourceNodeId != null && !resourceStarted) { "Watch resource scope is not current." }
        resourceStarted = true
        resourceListenerEpoch = epoch
      }
      try {
        Wearable.getCapabilityClient(context).addListener(resourceCapabilityListener, LINK_CAPABILITY).await()
        check(resourceCurrent(epoch)) { "Watch resource scope changed." }
        Wearable.getMessageClient(context).addListener(resourceListener).await()
        check(resourceCurrent(epoch)) { "Watch resource scope changed." }
        val nodes = Wearable.getCapabilityClient(context).getCapability(LINK_CAPABILITY, CapabilityClient.FILTER_REACHABLE).await().nodes
        val selected = synchronized(resourceLock) { resourceNodeId }
        check(resourceCurrent(epoch) && nodes.any { it.id == selected }) { "Watch resource companion unavailable." }
        Unit
      } catch (failure: Exception) {
        retireResources()
        removeResourceListeners(epoch)
        throw failure
      }
    }
    AsyncFunction("stopResources") Coroutine { epoch: Int ->
      val matches = synchronized(resourceLock) { resourceEpoch == epoch && resourceNodeId != null }
      if (matches) retireResources()
      removeResourceListeners(epoch)
      Unit
    }

    AsyncFunction("playHaptic") Coroutine { ->
      val context = requireContext()
      val node = preferredNode() ?: throw IllegalStateException("No reachable 101 watch app.")
      Wearable.getMessageClient(context).sendMessage(node.id, CONTROL_PATH, HAPTIC_PAYLOAD).await()
      Unit
    }

    OnDestroy {
      retireResources()
      runCatching { Wearable.getMessageClient(requireContext()).removeListener(resourceListener) }
      runCatching { Wearable.getCapabilityClient(requireContext()).removeListener(resourceCapabilityListener, LINK_CAPABILITY) }
      if (started) {
        runCatching { Wearable.getMessageClient(requireContext()).removeListener(listener) }
        started = false
      }
    }
  }

  private suspend fun removeResourceListeners(epoch: Int) {
    if (!synchronized(resourceLock) { resourceListenerEpoch == epoch }) return
    val context = requireContext()
    try {
      Wearable.getMessageClient(context).removeListener(resourceListener).await()
    } finally {
      try {
        Wearable.getCapabilityClient(context).removeListener(resourceCapabilityListener, LINK_CAPABILITY).await()
      } finally {
        synchronized(resourceLock) { if (resourceListenerEpoch == epoch) resourceListenerEpoch = null }
      }
    }
  }

  private fun resourceCurrent(epoch: Int): Boolean = synchronized(resourceLock) {
    resourceEpoch == epoch && resourceNodeId != null && resourceStarted
  }
  private fun retireResources() {
    val old = synchronized(resourceLock) {
      if (resourceNodeId == null) return
      val prior = resourceEpoch
      resourceNodeId = null
      resourceStarted = false
      resourceEpoch += 1
      prior
    }
    sendEvent("onWatchResourceLoss", mapOf("epoch" to old))
  }
  private fun onResourceMessage(event: MessageEvent) {
    if (event.path != SAMPLE_PATH || event.data.size != 53) return
    val epoch = synchronized(resourceLock) {
      if (resourceStarted && resourceNodeId == event.sourceNodeId) resourceEpoch else null
    } ?: return
    if (!resourceCurrent(epoch)) return
    sendEvent("onWatchResourceSample", mapOf("epoch" to epoch, "data" to Base64.encodeToString(event.data, Base64.NO_WRAP)))
  }

  private fun onMessage(event: MessageEvent) {
    if (!started || event.path != SAMPLE_PATH) return
    sendEvent("onWatchSample", mapOf("data" to Base64.encodeToString(event.data, Base64.NO_WRAP)))
  }

  private suspend fun snapshot(): Map<String, Any?> {
    val node = preferredNode()
    val connected = runCatching { Wearable.getNodeClient(requireContext()).connectedNodes.await() }
      .getOrDefault(emptyList())
    return mapOf(
      "platform" to "wearos",
      "companionPaired" to connected.isNotEmpty(),
      "appInstalled" to (node != null),
      "reachable" to (node != null && started),
      // The signal that separates a direct link from a possible network route.
      "nearby" to (node?.isNearby ?: false),
    )
  }

  /** Prefers a nearby node, so the honest answer is also the best-performing one. */
  private suspend fun preferredNode(): Node? {
    val context = requireContext()
    val capable = runCatching {
      Wearable.getCapabilityClient(context)
        .getCapability(LINK_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
        .await()
        .nodes
    }.getOrDefault(emptySet())
    return capable.firstOrNull { it.isNearby } ?: capable.firstOrNull()
  }

  private fun requireContext() =
    appContext.reactContext ?: throw IllegalStateException("101 Link has no Android context.")

  private companion object {
    const val LINK_CAPABILITY = "one01_link"
    const val SAMPLE_PATH = "/101/watch/sample"
    const val CONTROL_PATH = "/101/watch/control"
    val HAPTIC_PAYLOAD = byteArrayOf(1)
  }
}
