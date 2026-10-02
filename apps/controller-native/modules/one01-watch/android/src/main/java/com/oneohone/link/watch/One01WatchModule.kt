package com.oneohone.link.watch

import android.util.Base64
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

  override fun definition() = ModuleDefinition {
    Name("One01Watch")

    Events("onWatchSample", "onWatchLinkChange")

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

    AsyncFunction("playHaptic") Coroutine { ->
      val context = requireContext()
      val node = preferredNode() ?: throw IllegalStateException("No reachable 101 watch app.")
      Wearable.getMessageClient(context).sendMessage(node.id, CONTROL_PATH, HAPTIC_PAYLOAD).await()
      Unit
    }

    OnDestroy {
      if (started) {
        runCatching { Wearable.getMessageClient(requireContext()).removeListener(listener) }
        started = false
      }
    }
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
