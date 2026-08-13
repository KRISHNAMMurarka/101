package com.oneohone.wear

/**
 * How honestly 101 can describe the route a wrist sample takes.
 *
 * Mirrors `WatchLocality` in `@101/adapter-watch` and `WatchLocality` on watchOS, so the watch,
 * the phone and the game share one vocabulary.
 */
enum class WearLocality(val wireValue: String) {
    VERIFIED_LOCAL("verified-local"),
    ASSUMED_LOCAL("assumed-local"),
    CLOUD_POSSIBLE("cloud-possible"),
    UNKNOWN("unknown"),
}

/**
 * The Wearable Data Layer chooses its own transport. Google documents that it may carry data over
 * Bluetooth or over the network depending on connectivity, which means "connected" is not the same
 * claim as "local". `Node.isNearby` is the signal that actually distinguishes them: a nearby node
 * is reachable by a direct device-to-device link, while a connected-but-distant node may be routed
 * through Google's servers.
 *
 * 101 therefore refuses to report `VERIFIED_LOCAL` for a node that is merely connected. This is the
 * one place where being pessimistic is the correct behavior: a strict-local promise that is
 * sometimes false is worse than an honest "cloud-possible".
 */
data class WearLinkState(
    val companionPaired: Boolean = false,
    val appInstalled: Boolean = false,
    val reachable: Boolean = false,
    val nearby: Boolean = false,
) {
    val locality: WearLocality
        get() = when {
            !companionPaired -> WearLocality.UNKNOWN
            !appInstalled -> WearLocality.UNKNOWN
            !reachable -> WearLocality.UNKNOWN
            nearby -> WearLocality.VERIFIED_LOCAL
            else -> WearLocality.CLOUD_POSSIBLE
        }

    /** True only when the route is proven device-to-device. */
    val strictlyLocal: Boolean get() = locality == WearLocality.VERIFIED_LOCAL

    /**
     * Gameplay still runs over a `CLOUD_POSSIBLE` route if the player accepts it, because a
     * usable controller beats a refused one — but the UI must say so rather than implying local.
     */
    val canRelayRealtime: Boolean get() = reachable && appInstalled && companionPaired

    val note: String
        get() = when {
            !companionPaired -> "No paired phone."
            !appInstalled -> "101 Link is not installed on the paired phone."
            !reachable -> "No connected node is available yet."
            nearby -> "Connected directly to the paired phone."
            else -> "Connected, but this node is not reported nearby. The Data Layer may route through Google's network, so 101 does not claim this path is strictly local."
        }
}
